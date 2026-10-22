import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthResult, ROUTES, emptyProgress, type AppEvent } from "@lingo/core";
import type { AppleIdVerifier } from "../src/routes/auth";
import { makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
/** 假的苹果校验:identityToken 就是苹果用户 id */
const apple: AppleIdVerifier = { async verify(token) { return { sub: token }; } };
// 建 PGlite 要一两秒,几个测试文件并行时更慢,给足时间
beforeAll(async () => {
  t = await makeTestApp({ apple });
}, 60_000);
afterAll(async () => t?.app.close());

const later = (ms: number) => t.setNow(new Date(t.deps.now().getTime() + ms));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function smsLogin(phone: string) {
  await t.app.inject({ method: "POST", url: ROUTES.smsSend, payload: { phone } });
  const r = await t.app.inject({ method: "POST", url: ROUTES.smsVerify, payload: { phone, code: t.sentCodes.get(phone)! } });
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

    const del = await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: h });
    expect(del.statusCode).toBe(204);

    const row = await t.deps.db.selectFrom("users").selectAll().where("id", "=", me.user.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ phone: null, apple_sub: null, wechat_unionid: null, wechat_openid: null });
    expect(row.deleted_at).not.toBeNull();
    expect(await t.deps.db.selectFrom("progress").selectAll().where("user_id", "=", me.user.id).execute()).toEqual([]);
    expect(await t.deps.db.selectFrom("sms_codes").selectAll().where("phone", "=", phone).execute()).toEqual([]);
    // 埋点还在(统计用),但不再关联到这个人
    const events = await t.deps.db.selectFrom("events").select(["user_id"]).where("anon_id", "=", "anon_del_1").execute();
    expect(events).toEqual([{ user_id: null }, { user_id: null }]);

    // 旧 token:所有要登录的接口都 401(包括可选登录的埋点)
    for (const req of [
      { method: "GET" as const, url: ROUTES.me },
      { method: "GET" as const, url: ROUTES.progress("de") },
      { method: "DELETE" as const, url: ROUTES.account },
      { method: "POST" as const, url: ROUTES.events, payload: { events: [ev("anon_del_1")] } },
    ]) {
      const r = await t.app.inject({ ...req, headers: h });
      expect(r.statusCode, req.url).toBe(401);
      expect(r.json().error.message).toBe("账号已注销");
    }

    // 同一个手机号重新注册:新账号,和原来的没有关系
    later(61_000);
    const again = await smsLogin(phone);
    expect(again.isNew).toBe(true);
    expect(again.user.id).not.toBe(me.user.id);
    expect((await t.app.inject({ method: "GET", url: ROUTES.progress("de"), headers: bearer(again.token) })).json()).toEqual({ progress: null, rev: 0 });
  });

  it("Apple 账号注销后,再用 Apple 登录是新账号", async () => {
    const login = async () => AuthResult.parse((await t.app.inject({ method: "POST", url: ROUTES.appleLogin, payload: { identityToken: "apple-sub-to-delete" } })).json());
    const first = await login();
    expect((await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: bearer(first.token) })).statusCode).toBe(204);
    const second = await login();
    expect(second.isNew).toBe(true);
    expect(second.user.id).not.toBe(first.user.id);
    // 新账号正常可用
    expect((await t.app.inject({ method: "GET", url: ROUTES.me, headers: bearer(second.token) })).json()).toMatchObject({ id: second.user.id, hasApple: true });
  });

  it("注销只影响自己", async () => {
    const a = await smsLogin("13611112222");
    const b = await smsLogin("13633334444");
    await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: bearer(a.token) });
    expect((await t.app.inject({ method: "GET", url: ROUTES.me, headers: bearer(b.token) })).statusCode).toBe(200);
  });
});
