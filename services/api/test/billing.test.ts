import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appleNotificationEvents, appleTransactionEvents, StoreVerificationError, type AppStoreVerifier } from "@lingo/billing";
import { createFakeApple } from "@lingo/billing/test/fake-apple";
import {
  appleNotification, appleRenewal, appleTx, at, BUNDLE_ID, NotificationTypeV2 as N, renewalTx, Subtype, T0, trialTx,
  type JWSRenewalInfoDecodedPayload, type JWSTransactionDecodedPayload, type ResponseBodyV2DecodedPayload,
} from "@lingo/billing/test/payloads";
import { ROUTES } from "@lingo/core";
import { signSession } from "../src/auth/session";
import { testConfig } from "../src/config";
import { createAppStoreVerifier, getPremium } from "../src/routes/billing";
import { makeTestApp, type TestApp } from "./helpers";

/**
 * 假的 App Store 校验器:"签名串"就是 base64 的 JSON,"校验"只是解码,事件映射用 @lingo/billing 的真实函数。
 * 签名校验本身在 packages/billing 的测试里用自己生成的证书链测;这里测服务器的流程(最后一组用真实校验器走一遍)。
 */
const enc = (o: object) => `fake.${Buffer.from(JSON.stringify(o)).toString("base64url")}`;
function dec<T>(s: string): T {
  if (s.startsWith("retry.")) throw new StoreVerificationError("连不上苹果", true, "RETRYABLE_VERIFICATION_FAILURE");
  if (!s.startsWith("fake.")) throw new StoreVerificationError("签名不对", false, "VERIFICATION_FAILURE");
  return JSON.parse(Buffer.from(s.slice(5), "base64url").toString()) as T;
}
const fakeAppStore: AppStoreVerifier = {
  async verifyTransaction(s) {
    const tx = dec<JWSTransactionDecodedPayload>(s);
    return {
      originalTransactionId: tx.originalTransactionId!, transactionId: tx.transactionId!, productId: tx.productId!,
      appAccountToken: tx.appAccountToken || undefined, environment: String(tx.environment), periodEnd: new Date(tx.expiresDate!),
      events: appleTransactionEvents(tx), raw: { transaction: tx },
    };
  },
  async verifyNotification(s) {
    const { n, tx, renewal } = dec<{ n: ResponseBodyV2DecodedPayload; tx?: JWSTransactionDecodedPayload; renewal?: JWSRenewalInfoDecodedPayload }>(s);
    return {
      notificationUUID: n.notificationUUID!, notificationType: String(n.notificationType), subtype: n.subtype ? String(n.subtype) : undefined,
      originalTransactionId: tx?.originalTransactionId, transactionId: tx?.transactionId, productId: tx?.productId,
      appAccountToken: tx?.appAccountToken || renewal?.appAccountToken || undefined, environment: "Sandbox",
      periodEnd: tx?.expiresDate ? new Date(tx.expiresDate) : undefined, signedAt: new Date(n.signedDate!),
      events: appleNotificationEvents(n, tx, renewal), raw: { notification: n },
    };
  },
};

// 整个文件共用一个服务器和数据库(PGlite 启动慢);每个用例用自己的用户和交易 id,互不影响。
// PGlite 启动很吃 CPU,而测试文件是并行跑的(每个文件一个子进程):把本文件进程的优先级调低,
// 免得在机器忙的时候拖慢别的测试文件(它们在用例里启动数据库,超时是默认的 5 秒)
try {
  setPriority(19);
} catch {
  // 没有权限调整就算了
}
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ appStore: fakeAppStore });
}, 120_000);
afterAll(async () => t?.app.close());
beforeEach(() => {
  t.deps.appStore = fakeAppStore;
  t.setNow(new Date(T0));
});

let storyNo = 0;
/** 一个订阅的一组交易:原始交易 id 每个用例不同 */
function story(token?: string) {
  const base = 3_000_000_000 + ++storyNo * 1000;
  const orig = String(base);
  const tok = token === undefined ? {} : { appAccountToken: token };
  return {
    orig,
    tx: (over: Partial<JWSTransactionDecodedPayload> = {}) => appleTx({ transactionId: orig, originalTransactionId: orig, ...tok, ...over }),
    trial: (over: Partial<JWSTransactionDecodedPayload> = {}) => trialTx({ transactionId: orig, originalTransactionId: orig, ...tok, ...over }),
    renewal: (n: number, fromDay: number, toDay: number, over: Partial<JWSTransactionDecodedPayload> = {}) =>
      renewalTx(String(base + n), fromDay, toDay, { originalTransactionId: orig, ...tok, ...over }),
    info: (over: Partial<JWSRenewalInfoDecodedPayload> = {}) => appleRenewal({ originalTransactionId: orig, ...tok, ...over }),
  };
}

type Auth = Record<string, string>;
async function newUser(id = randomUUID()) {
  await t.deps.db.insertInto("users").values({ id, phone: null, apple_sub: null, wechat_unionid: null, created_at: new Date(), deleted_at: null }).execute();
  return { id, auth: { authorization: `Bearer ${await signSession(id, t.deps.config)}` } as Auth };
}
const report = (auth: Auth, tx: JWSTransactionDecodedPayload, signed = enc(tx)) =>
  t.app.inject({ method: "POST", url: ROUTES.appleTransaction, headers: auth, payload: { signedTransaction: signed } });
const notify = (n: ResponseBodyV2DecodedPayload, tx?: JWSTransactionDecodedPayload, renewal?: JWSRenewalInfoDecodedPayload) =>
  t.app.inject({ method: "POST", url: ROUTES.appleNotification, payload: { signedPayload: enc({ n, tx, renewal }) } });
const getSub = async (auth: Auth) => (await t.app.inject({ method: "GET", url: ROUTES.subscription, headers: auth })).json();
const eventsOf = (orig: string) =>
  t.deps.db.selectFrom("subscription_events").select(["id", "type", "product_id", "source", "environment", "user_id"])
    .where("original_transaction_id", "=", orig).orderBy("seq").execute();
const notesOf = (orig: string) =>
  t.deps.db.selectFrom("apple_notifications").select(["type", "user_id"]).where("original_transaction_id", "=", orig).orderBy("received_at").execute();

describe("会员状态和 App 上报交易", () => {
  it("没登录 401;没配置苹果时回 503「支付服务暂未开通」;会员状态照常能查", async () => {
    t.deps.appStore = null;
    const u = await newUser();
    expect((await t.app.inject({ method: "GET", url: ROUTES.subscription })).statusCode).toBe(401);
    expect(await getSub(u.auth)).toEqual({ subscription: null, premium: false });
    const r = await report(u.auth, story(u.id).trial());
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "billing_disabled", message: "支付服务暂未开通" } });
    expect((await notify(appleNotification(N.TEST))).statusCode).toBe(503);
  });

  it("完整流程:上报试用交易 → 查询会员 → 苹果通知(重复、续费、退款)→ 状态变化", async () => {
    const u = await newUser();
    const s = story(u.id);
    const trial = s.trial();

    const r = await report(u.auth, trial);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      premium: true,
      subscription: { status: "trial", productId: "premium_yearly", platform: "ios", trialUsed: true, autoRenew: true, periodEnd: new Date(at(7)).toISOString() },
    });
    expect(await getSub(u.auth)).toEqual(r.json());
    expect(await getPremium(t.deps, u.id)).toBe(true);

    // 苹果的开通通知和 App 上报是同一件事;App 再报一次(恢复购买)也一样:流水只有一条
    expect((await notify(appleNotification(N.SUBSCRIBED, Subtype.INITIAL_BUY), trial, s.info())).json()).toEqual({ ok: true });
    expect((await report(u.auth, trial)).statusCode).toBe(200);
    expect(await eventsOf(s.orig)).toEqual([
      { id: `apple:tx:${s.orig}:start-trial`, type: "start-trial", product_id: "premium_yearly", source: "apple-transaction", environment: "Sandbox", user_id: u.id },
    ]);

    // 试用转正
    t.setNow(new Date(at(7.1)));
    const year1 = s.renewal(1, 7, 372);
    const renew = appleNotification(N.DID_RENEW, undefined, 7);
    expect((await notify(renew, year1)).statusCode).toBe(200);
    expect(await getSub(u.auth)).toMatchObject({ premium: true, subscription: { status: "active", periodEnd: new Date(at(372)).toISOString() } });

    // 同一条通知重复发来:不重复处理
    expect((await notify(renew, year1)).statusCode).toBe(200);
    expect((await eventsOf(s.orig)).map((e) => e.type)).toEqual(["start-trial", "renewed"]);
    expect(await notesOf(s.orig)).toEqual([{ type: "SUBSCRIBED", user_id: u.id }, { type: "DID_RENEW", user_id: u.id }]);

    // 退款:会员撤销
    t.setNow(new Date(at(30)));
    expect((await notify(appleNotification(N.REFUND, undefined, 30), { ...year1, revocationDate: at(30) })).statusCode).toBe(200);
    expect(await getSub(u.auth)).toMatchObject({ premium: false, subscription: { status: "revoked", autoRenew: false } });
    expect(await getPremium(t.deps, u.id)).toBe(false);
    expect((await eventsOf(s.orig)).map((e) => e.type)).toEqual(["start-trial", "renewed", "refunded"]);
  });

  it("交易的账号标识不是当前用户(或没有):拒绝,不开通", async () => {
    const owner = await newUser();
    const other = await newUser();
    const s = story(owner.id);
    const r = await report(other.auth, s.trial());
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toEqual({ code: "wrong_account", message: "这笔购买属于另一个语途账号,请登录购买时用的账号" });
    expect((await report(other.auth, s.trial({ appAccountToken: "" }))).json().error.code).toBe("no_account_token");
    expect(await getSub(other.auth)).toEqual({ subscription: null, premium: false });
    expect(await eventsOf(s.orig)).toEqual([]);
    // 账号标识大小写不同算同一个人
    expect((await report(owner.auth, s.trial({ appAccountToken: owner.id.toUpperCase() }))).json().premium).toBe(true);
  });

  it("校验不通过回 400;暂时连不上苹果回 503", async () => {
    const u = await newUser();
    const bad = await report(u.auth, appleTx(), "forged.xxxxxxxxxx");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toEqual({ code: "invalid_receipt", message: "购买凭证校验失败" });
    expect((await report(u.auth, appleTx(), "retry.xxxxxxxxxx")).statusCode).toBe(503);
    expect((await t.app.inject({ method: "POST", url: ROUTES.appleNotification, payload: { signedPayload: "forged.xxxxxxxxxx" } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: ROUTES.appleNotification, payload: {} })).statusCode).toBe(400);
  });
});

describe("App Store 服务器通知", () => {
  it("关闭自动续费、扣费失败进入宽限期、宽限期结束、补扣成功、过期;乱序晚到的旧通知不改状态", async () => {
    const u = await newUser();
    const s = story(u.id);
    const year1 = s.tx();
    await report(u.auth, year1);

    await notify(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_DISABLED, 100), year1, s.info({ autoRenewStatus: 0 }));
    expect((await getSub(u.auth)).subscription.autoRenew).toBe(false);
    await notify(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_ENABLED, 101), year1, s.info());
    expect((await getSub(u.auth)).subscription.autoRenew).toBe(true);

    t.setNow(new Date(at(366)));
    await notify(appleNotification(N.DID_FAIL_TO_RENEW, Subtype.GRACE_PERIOD, 365), year1, s.info({ gracePeriodExpiresDate: at(381) }));
    expect(await getSub(u.auth)).toMatchObject({ premium: true, subscription: { status: "grace", graceEnd: new Date(at(381)).toISOString() } });
    t.setNow(new Date(at(382)));
    await notify(appleNotification(N.GRACE_PERIOD_EXPIRED, undefined, 381), year1, s.info());
    expect(await getSub(u.auth)).toMatchObject({ premium: false, subscription: { status: "billing-retry" } });

    const year2 = s.renewal(1, 383, 748);
    await notify(appleNotification(N.DID_RENEW, Subtype.BILLING_RECOVERY, 383), year2);
    const now = await getSub(u.auth);
    expect(now).toMatchObject({ premium: true, subscription: { status: "active", periodEnd: new Date(at(748)).toISOString() } });

    // 苹果重发的旧一期扣费失败通知(新的通知 id)晚到:属于旧的一期,只记流水
    await notify(appleNotification(N.DID_FAIL_TO_RENEW, undefined, 365), year1, s.info());
    expect(await getSub(u.auth)).toEqual(now);

    t.setNow(new Date(at(748.5)));
    await notify(appleNotification(N.EXPIRED, Subtype.VOLUNTARY, 748.5), year2, s.info({ autoRenewStatus: 0 }));
    expect(await getSub(u.auth)).toMatchObject({ premium: false, subscription: { status: "expired", autoRenew: false } });
  });

  it("升降级:降级下一期生效(先改续费商品),续费时换成新商品", async () => {
    const u = await newUser();
    const s = story(u.id);
    await report(u.auth, s.tx());
    await notify(appleNotification(N.DID_CHANGE_RENEWAL_PREF, Subtype.DOWNGRADE, 30), s.tx(), s.info({ autoRenewProductId: "premium_monthly" }));
    expect((await getSub(u.auth)).subscription).toMatchObject({ productId: "premium_yearly", renewProductId: "premium_monthly" });
    t.setNow(new Date(at(366)));
    await notify(appleNotification(N.DID_RENEW, undefined, 365), s.renewal(1, 365, 395, { productId: "premium_monthly" }));
    const sub = (await getSub(u.auth)).subscription;
    expect(sub).toMatchObject({ productId: "premium_monthly", status: "active" });
    expect(sub.renewProductId).toBeUndefined();
  });

  it("找不到用户的通知先记下;用户上报同一订阅的交易时补上", async () => {
    const id = randomUUID();
    const s = story(id);
    // 通知到的时候还找不到这个用户
    expect((await notify(appleNotification(N.SUBSCRIBED, Subtype.INITIAL_BUY, 0), s.trial(), s.info())).statusCode).toBe(200);
    expect((await notify(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_DISABLED, 2), s.trial(), s.info({ autoRenewStatus: 0 }))).statusCode).toBe(200);
    expect((await eventsOf(s.orig)).map((e) => [e.type, e.user_id])).toEqual([["start-trial", null], ["auto-renew", null]]);
    expect(await notesOf(s.orig)).toEqual([{ type: "SUBSCRIBED", user_id: null }, { type: "DID_CHANGE_RENEWAL_STATUS", user_id: null }]);

    t.setNow(new Date(at(3)));
    const u = await newUser(id);
    const r = await report(u.auth, s.trial());
    // 试用 + 之前通知里的"关闭自动续费"都补上了
    expect(r.json()).toMatchObject({ premium: true, subscription: { status: "trial", autoRenew: false } });
    expect((await eventsOf(s.orig)).map((e) => [e.type, e.user_id])).toEqual([["start-trial", id], ["auto-renew", id]]);
    expect((await notesOf(s.orig)).map((n) => n.user_id)).toEqual([id, id]);
  });

  it("通知通过原始交易 id 找到用户(交易里没有账号标识时)", async () => {
    const u = await newUser();
    const s = story(u.id);
    await report(u.auth, s.tx());
    t.setNow(new Date(at(366)));
    await notify(appleNotification(N.DID_RENEW, undefined, 365), s.renewal(1, 365, 730, { appAccountToken: undefined }));
    expect((await getSub(u.auth)).subscription.periodEnd).toBe(new Date(at(730)).toISOString());
  });

  it("测试通知、不认识的商品:回 200,不改任何人的会员", async () => {
    const u = await newUser();
    const s = story(u.id);
    const test = appleNotification(N.TEST);
    expect((await notify(test)).json()).toEqual({ ok: true });
    expect((await notify(appleNotification(N.SUBSCRIBED), s.tx({ productId: "lifetime" }))).statusCode).toBe(200);
    expect(await getSub(u.auth)).toEqual({ subscription: null, premium: false });
    expect(await t.deps.db.selectFrom("apple_notifications").select("type").where("id", "=", test.notificationUUID!).execute()).toEqual([{ type: "TEST" }]);
    expect(await notesOf(s.orig)).toEqual([{ type: "SUBSCRIBED", user_id: u.id }]);
  });
});

describe("createAppStoreVerifier 和真实签名校验", () => {
  const dir = mkdtempSync(join(tmpdir(), "apple-roots-"));
  const apple = createFakeApple();
  writeFileSync(join(dir, "AppleRootCA-G3.cer"), apple.rootCert);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = (over: Partial<ReturnType<typeof testConfig>["apple"]> = {}) => testConfig({ apple: { bundleId: BUNDLE_ID, environment: "Sandbox", ...over } });

  it("缺配置返回 null", () => {
    expect(createAppStoreVerifier(cfg(), {})).toBeNull();
    expect(createAppStoreVerifier(cfg(), { APPLE_ROOT_CERTS_DIR: join(dir, "nope") })).toBeNull();
    expect(createAppStoreVerifier(cfg({ environment: "Production" }), { APPLE_ROOT_CERTS_DIR: dir })).toBeNull();
    expect(createAppStoreVerifier({ ...cfg({ environment: "LocalTesting" }), env: "production" }, {})).toBeNull();
    expect(createAppStoreVerifier(cfg({ environment: "LocalTesting" }), {})).not.toBeNull();
    expect(createAppStoreVerifier(cfg({ environment: "Production", appAppleId: 1234567890 }), { APPLE_ROOT_CERTS_DIR: dir })).not.toBeNull();
  });

  it("端到端:苹果签名的交易和通知 → 会员;伪造的签名被拒", async () => {
    t.deps.appStore = createAppStoreVerifier(cfg(), { APPLE_ROOT_CERTS_DIR: dir });
    expect(t.deps.appStore).not.toBeNull();
    const u = await newUser();
    const s = story(u.id);
    const trial = s.trial();
    expect((await report(u.auth, trial, apple.transaction(trial))).json()).toMatchObject({ premium: true, subscription: { status: "trial" } });
    const off = apple.notification(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_DISABLED, 1), {
      bundleId: BUNDLE_ID, environment: "Sandbox", tx: trial, renewal: s.info({ autoRenewStatus: 0 }),
    });
    expect((await t.app.inject({ method: "POST", url: ROUTES.appleNotification, payload: { signedPayload: off } })).statusCode).toBe(200);
    expect((await getSub(u.auth)).subscription.autoRenew).toBe(false);
    expect((await report(u.auth, trial, createFakeApple().transaction(trial))).statusCode).toBe(400);
  });
});
