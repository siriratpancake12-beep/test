import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthResult, ROUTES, emptyProgress, type AppEvent, type Subscription } from "@lingo/core";
import { buildApp } from "../src/app";
import type { AppleIdVerifier, AppleTokenClient } from "../src/routes/auth";
import { makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
/** 没配 Sign in with Apple 密钥的服务器(和 t 共用数据库) */
let noKeys: FastifyInstance;
/** 假的苹果校验:identityToken 就是苹果用户 id */
const apple: AppleIdVerifier = { async verify(token) { return { sub: token }; } };
/** 假的苹果令牌接口:授权码 "code:<sub>" 换出刷新令牌 "rt:<sub>";记下撤销了哪些 */
const revoked: string[] = [];
let revokeFails = false;
const appleTokens: AppleTokenClient = {
  async exchangeCode(code) {
    const sub = code.replace(/^code:/, "");
    return { refreshToken: `rt:${sub}`, sub };
  },
  async revoke(token) {
    if (revokeFails) throw new Error("连不上苹果");
    revoked.push(token);
  },
};
// 建 PGlite 要一两秒,几个测试文件并行时更慢,给足时间
beforeAll(async () => {
  t = await makeTestApp({ apple, appleTokens });
  noKeys = await buildApp({ ...t.deps, appleTokens: null });
}, 60_000);
afterAll(async () => {
  await noKeys?.close();
  await t?.app.close();
});
beforeEach(() => {
  revoked.length = 0;
  revokeFails = false;
});

const later = (ms: number) => t.setNow(new Date(t.deps.now().getTime() + ms));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const del = (token: string, app: FastifyInstance = t.app) => app.inject({ method: "DELETE", url: ROUTES.account, headers: bearer(token) });

async function smsLogin(phone: string) {
  await t.app.inject({ method: "POST", url: ROUTES.smsSend, payload: { phone } });
  const r = await t.app.inject({ method: "POST", url: ROUTES.smsVerify, payload: { phone, code: t.sentCodes.get(phone)! } });
  expect(r.statusCode).toBe(200);
  return AuthResult.parse(r.json());
}
async function appleLogin(sub: string, withCode = true) {
  const r = await t.app.inject({ method: "POST", url: ROUTES.appleLogin, payload: { identityToken: sub, ...(withCode ? { authorizationCode: `code:${sub}` } : {}) } });
  expect(r.statusCode).toBe(200);
  return AuthResult.parse(r.json());
}

let seq = 0;
const ev = (anonId: string): AppEvent => ({
  id: `acc_${String(++seq).padStart(8, "0")}`, name: "review_complete", at: "2026-11-01T11:00:00.000Z",
  anonId, props: { cards: 10, correct: 9 }, platform: "android", appVersion: "1.0.0",
});

describe("账号信息", () => {
  it("没登录 401;token 不对 401(提示重新登录)", async () => {
    const r = await t.app.inject({ method: "GET", url: ROUTES.me });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toEqual({ code: "unauthorized", message: "请先登录" });
    const bad = await t.app.inject({ method: "GET", url: ROUTES.me, headers: bearer("abc.def.ghi") });
    expect(bad.json().error.message).toBe("登录已过期,请重新登录");
  });
});

describe("注销账号", () => {
  it("删除手机号和学习进度,埋点和账号断开,旧 token 立即失效;同一手机号可以注册成新账号", async () => {
    const phone = "13512345678";
    const me = await smsLogin(phone);
    const h = bearer(me.token);
    expect((await t.app.inject({ method: "PUT", url: ROUTES.progress("de"), headers: h, payload: { progress: emptyProgress("de"), baseRev: 0 } })).statusCode).toBe(200);
    await t.app.inject({ method: "POST", url: ROUTES.events, headers: h, payload: { events: [ev("anon_del_1"), ev("anon_del_1")] } });

    expect((await del(me.token)).statusCode).toBe(204);

    const row = await t.deps.db.selectFrom("users").selectAll().where("id", "=", me.user.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ phone: null, apple_sub: null, apple_refresh_token: null, wechat_unionid: null, wechat_openid: null });
    expect(row.deleted_at).not.toBeNull();
    expect(await t.deps.db.selectFrom("progress").selectAll().where("user_id", "=", me.user.id).execute()).toEqual([]);
    expect(await t.deps.db.selectFrom("sms_codes").selectAll().where("phone", "=", phone).execute()).toEqual([]);
    // 埋点还在(统计用),但不再关联到这个人
    const events = await t.deps.db.selectFrom("events").select(["user_id"]).where("anon_id", "=", "anon_del_1").execute();
    expect(events).toEqual([{ user_id: null }, { user_id: null }]);

    // 旧 token:要登录的接口都 401
    for (const req of [
      { method: "GET" as const, url: ROUTES.me },
      { method: "GET" as const, url: ROUTES.progress("de") },
      { method: "DELETE" as const, url: ROUTES.account },
    ]) {
      const r = await t.app.inject({ ...req, headers: h });
      expect(r.statusCode, req.url).toBe(401);
      expect(r.json().error.message).toBe("账号已注销");
    }
    // 埋点是可选登录:旧 token 带来的照收,按没登录记
    const late = ev("anon_del_1");
    expect((await t.app.inject({ method: "POST", url: ROUTES.events, headers: h, payload: { events: [late] } })).json()).toEqual({ accepted: 1 });
    expect(await t.deps.db.selectFrom("events").select("user_id").where("id", "=", late.id).executeTakeFirst()).toEqual({ user_id: null });

    // 同一个手机号重新注册:新账号,和原来的没有关系
    later(61_000);
    const again = await smsLogin(phone);
    expect(again.isNew).toBe(true);
    expect(again.user.id).not.toBe(me.user.id);
    expect((await t.app.inject({ method: "GET", url: ROUTES.progress("de"), headers: bearer(again.token) })).json()).toEqual({ progress: null, rev: 0 });
  });

  it("订阅状态删掉、交易流水保留但不再关联;AI 用量记录删掉", async () => {
    const me = await smsLogin("13522223333");
    const id = me.user.id;
    const sub: Subscription = { productId: "premium_yearly", platform: "ios", status: "active", periodEnd: "2027-11-01T00:00:00.000Z", autoRenew: true, trialUsed: true, reminders: [] };
    const db = t.deps.db;
    await db.insertInto("subscriptions").values({ user_id: id, data: JSON.stringify(sub), original_transaction_id: "otx-del", updated_at: new Date() }).execute();
    await db.insertInto("subscription_events").values({ id: "se-del-1", user_id: id, type: "purchase", product_id: "premium_yearly", at: new Date(), source: "test", raw: null }).execute();
    await db.insertInto("apple_notifications").values({ id: "an-del-1", type: "SUBSCRIBED", subtype: null, original_transaction_id: "otx-del", user_id: id, environment: "Production", signed_at: new Date(), raw: null }).execute();
    await db.insertInto("ai_usage").values([{ user_id: id, day: "2026-11-01", kind: "tutor", count: 5 }, { user_id: id, day: "2026-11-01", kind: "speech", count: 2 }]).execute();

    expect((await del(me.token)).statusCode).toBe(204);
    expect(await db.selectFrom("subscriptions").selectAll().where("user_id", "=", id).execute()).toEqual([]);
    expect(await db.selectFrom("subscription_events").select(["id", "user_id", "type"]).where("id", "=", "se-del-1").execute()).toEqual([{ id: "se-del-1", user_id: null, type: "purchase" }]);
    expect(await db.selectFrom("apple_notifications").select(["user_id"]).where("id", "=", "an-del-1").execute()).toEqual([{ user_id: null }]);
    expect(await db.selectFrom("ai_usage").selectAll().where("user_id", "=", id).execute()).toEqual([]);
  });

  it("Apple 登录的账号:注销时用保存的刷新令牌向苹果撤销授权;再用 Apple 登录是新账号", async () => {
    const first = await appleLogin("apple-sub-to-delete");
    expect((await del(first.token)).statusCode).toBe(204);
    expect(revoked).toEqual(["rt:apple-sub-to-delete"]);
    const second = await appleLogin("apple-sub-to-delete");
    expect(second.isNew).toBe(true);
    expect(second.user.id).not.toBe(first.user.id);
    expect((await t.app.inject({ method: "GET", url: ROUTES.me, headers: bearer(second.token) })).json()).toMatchObject({ id: second.user.id, hasApple: true });
  });

  it("向苹果撤销失败、没有刷新令牌、没配密钥:都照样注销", async () => {
    revokeFails = true;
    const a = await appleLogin("apple-revoke-fails");
    expect((await del(a.token)).statusCode).toBe(204);
    expect(await t.deps.db.selectFrom("users").select("apple_refresh_token").where("id", "=", a.user.id).executeTakeFirst()).toEqual({ apple_refresh_token: null });
    revokeFails = false;

    const b = await appleLogin("apple-no-code", false);
    expect((await del(b.token)).statusCode).toBe(204);

    const c = await appleLogin("apple-no-keys");
    expect((await del(c.token, noKeys)).statusCode).toBe(204);
    expect(revoked).toEqual([]);
    expect((await t.app.inject({ method: "GET", url: ROUTES.me, headers: bearer(c.token) })).statusCode).toBe(401);
  });

  it("注销只影响自己", async () => {
    const a = await smsLogin("13611112222");
    const b = await smsLogin("13633334444");
    await del(a.token);
    expect((await t.app.inject({ method: "GET", url: ROUTES.me, headers: bearer(b.token) })).statusCode).toBe(200);
  });
});
