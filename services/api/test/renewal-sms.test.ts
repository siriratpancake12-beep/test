import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, type Subscription } from "@lingo/core";
import { AliyunSmsError } from "../src/auth/aliyun-sms";
import type { JobLog } from "../src/jobs";
import { RENEWAL_SMS, renewalSmsPlan, sendRenewalReminders, smsHours } from "../src/jobs/renewal-sms";
import type { SmsNotifier } from "../src/routes/auth";
import { createUser, makeTestApp, type TestApp } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TEMPLATE = "SMS_RENEW_1";

/**
 * 扣费前短信提醒(jobs/renewal-sms.ts),假的短信发送器。
 * 整个文件共用一个数据库;每个测试用自己的时间段(相隔 60 天,北京时间上午 10 点),前面测试的订阅到时候都已经过期,不会混进来。
 */
let t: TestApp;
let sent: { phone: string; templateCode: string; params: Record<string, string> }[] = [];
/** 下一次发送要抛的错(null 表示发送成功) */
let failWith: Error | null = null;
/** 发送前等一会儿(模拟两台服务器同时在发) */
let delayMs = 0;
const notifier: SmsNotifier = {
  async notify(phone, templateCode, params) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failWith) throw failWith;
    sent.push({ phone, templateCode, params });
  },
};
const logs: string[] = [];
const log: JobLog = { info: (_o, m) => logs.push(m), warn: (_o, m) => logs.push(m), error: (_o, m) => logs.push(m) };

beforeAll(async () => {
  t = await makeTestApp();
}, 60_000);
afterAll(async () => t?.app.close());

let era = -1;
let base = new Date();
beforeEach(() => {
  era++;
  // 北京时间上午 10 点
  base = new Date(Date.parse("2026-11-02T02:00:00Z") + era * 60 * DAY);
  t.setNow(base);
  sent = [];
  failWith = null;
  delayMs = 0;
  logs.length = 0;
});
const at = (ms: number) => new Date(base.getTime() + ms);
/** templateCode 传 null 表示没配模板 */
const run = (now: Date, templateCode: string | null = TEMPLATE) => sendRenewalReminders({ db: t.deps.db, now, notifier, templateCode: templateCode ?? undefined, log });

let n = 0;
/** 一个会员:默认是绑了手机号、开着自动续费的年度会员,苹果正式环境的订阅,periodIn 之后到期 */
async function member(periodIn: number, o: { sub?: Partial<Subscription>; phone?: string | null; env?: string | null } = {}) {
  const phone = o.phone === null ? undefined : (o.phone ?? `1360000${String(++n).padStart(4, "0")}`);
  const u = await createUser(t, { phone });
  const otid = `otx-rs-${u.userId}`;
  const data: Subscription = {
    productId: "premium_yearly", platform: "ios", status: "active", autoRenew: true, trialUsed: true, reminders: [],
    periodEnd: at(periodIn).toISOString(), ...o.sub,
  };
  await t.deps.db.insertInto("subscriptions").values({ user_id: u.userId, data: JSON.stringify(data), original_transaction_id: otid, updated_at: base }).execute();
  if (o.env !== null) {
    await t.deps.db.insertInto("subscription_events").values({
      id: `se-${otid}`, user_id: u.userId, type: "purchase", product_id: data.productId, at: base, source: "test", raw: null,
      original_transaction_id: otid, period_end: new Date(data.periodEnd), event: null, environment: o.env ?? "Production",
    }).execute();
  }
  return { ...u, phone, otid, data };
}
const rowsOf = (userId: string) =>
  t.deps.db.selectFrom("renewal_sms").select(["status", "attempts", "error", "product_id", "price_cny", "period_end"]).where("user_id", "=", userId).execute();
/** 到期时间在北京时间是哪天(写法在"什么时候发"里用固定日期核对过) */
const bjDate = (iso: string) => {
  const d = new Date(Date.parse(iso) + 8 * HOUR);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};

describe("什么时候发", () => {
  it("北京时间 8 点到 21 点", () => {
    expect(smsHours(new Date("2026-11-01T23:59:59Z"))).toBe(false); // 北京 7:59:59
    expect(smsHours(new Date("2026-11-02T00:00:00Z"))).toBe(true); // 北京 8:00
    expect(smsHours(new Date("2026-11-02T12:59:59Z"))).toBe(true); // 北京 20:59:59
    expect(smsHours(new Date("2026-11-02T13:00:00Z"))).toBe(false); // 北京 21:00
  });

  it("离到期 1 天以上、5 天半以内才发;关了续费、过期、扣费失败的不发", () => {
    const now = new Date("2026-11-02T02:00:00Z");
    const sub = (left: number, over: Partial<Subscription> = {}): Subscription => ({
      productId: "premium_yearly", platform: "ios", status: "active", autoRenew: true, trialUsed: true, reminders: [],
      periodEnd: new Date(now.getTime() + left).toISOString(), ...over,
    });
    const window = RENEWAL_SMS.leadMs + RENEWAL_SMS.earlyMs;
    expect(window).toBe(5.5 * DAY);
    expect(renewalSmsPlan(sub(window), now)).not.toBeNull();
    expect(renewalSmsPlan(sub(window + 1), now)).toBeNull();
    expect(renewalSmsPlan(sub(DAY + 1), now)).not.toBeNull();
    expect(renewalSmsPlan(sub(DAY), now)).toBeNull();
    expect(renewalSmsPlan(sub(5 * DAY, { autoRenew: false }), now)).toBeNull();
    for (const status of ["expired", "revoked", "grace", "billing-retry"] as const) expect(renewalSmsPlan(sub(5 * DAY, { status }), now), status).toBeNull();
    expect(renewalSmsPlan(null, now)).toBeNull();
  });

  it("短信内容:商品、到期日(北京时间)、价格(数字)", () => {
    const now = new Date("2026-11-02T02:00:00Z");
    const sub = (left: number): Subscription => ({
      productId: "premium_yearly", platform: "ios", status: "active", autoRenew: true, trialUsed: true, reminders: [],
      periodEnd: new Date(now.getTime() + left).toISOString(),
    });
    // 2026-11-07 08:00 UTC = 北京时间 11 月 7 日 16 点
    expect(renewalSmsPlan(sub(5 * DAY + 6 * HOUR), now)?.params).toEqual({ product: "年度会员", date: "2026年11月7日", price: "298" });
    // 2026-11-06 17:00 UTC = 北京时间 11 月 7 日 1 点
    expect(renewalSmsPlan(sub(4 * DAY + 15 * HOUR), now)?.params.date).toBe("2026年11月7日");
    expect(bjDate(sub(4 * DAY + 15 * HOUR).periodEnd)).toBe("2026年11月7日");
  });
});

describe("扣费前短信", () => {
  it("离到期 5 天到 5 天半之间:发一条,写明商品、到期日(北京时间)和价格;同一期不再发", async () => {
    const m = await member(5 * DAY + 6 * HOUR);
    expect(await run(base)).toEqual({ due: 1, sent: 1, failed: 0, unknown: 0 });
    expect(sent).toEqual([{ phone: m.phone, templateCode: TEMPLATE, params: { product: "年度会员", date: bjDate(m.data.periodEnd), price: "298" } }]);
    expect(await rowsOf(m.userId)).toEqual([
      { status: "sent", attempts: 1, error: null, product_id: "premium_yearly", price_cny: 298, period_end: new Date(m.data.periodEnd) },
    ]);
    expect(await run(at(HOUR))).toEqual({ due: 0, sent: 0, failed: 0, unknown: 0 });
    expect(await run(at(DAY))).toEqual({ due: 0, sent: 0, failed: 0, unknown: 0 });
    expect(sent).toHaveLength(1);
  });

  it("还没到 5 天半不发,一进窗口就发", async () => {
    const m = await member(5 * DAY + 13 * HOUR);
    expect((await run(base)).sent).toBe(0);
    expect((await run(at(HOUR))).sent).toBe(1);
    expect(sent.map((s) => s.phone)).toEqual([m.phone]);
  });

  it("试用按年度会员的价格提醒;降级的按下一期的月度会员;月度会员按月度", async () => {
    const trial = await member(5 * DAY, { sub: { status: "trial" } });
    const down = await member(5 * DAY, { sub: { renewProductId: "premium_monthly" } });
    const monthly = await member(5 * DAY, { sub: { productId: "premium_monthly" } });
    expect((await run(base)).sent).toBe(3);
    const by = (phone: string | undefined) => sent.find((s) => s.phone === phone)?.params;
    expect(by(trial.phone)).toMatchObject({ product: "年度会员", price: "298" });
    expect(by(down.phone)).toMatchObject({ product: "月度会员", price: "45" });
    expect(by(monthly.phone)).toMatchObject({ product: "月度会员", price: "45" });
    expect((await rowsOf(down.userId))[0]).toMatchObject({ product_id: "premium_monthly", price_cny: 45 });
  });

  it("不发:关了自动续费、过期、宽限期、注销了、没绑手机号(Apple 登录)、沙盒订阅、没有正式环境的流水、离到期不到 1 天", async () => {
    await member(5 * DAY, { sub: { autoRenew: false } });
    await member(5 * DAY, { sub: { status: "expired" } });
    await member(5 * DAY, { sub: { status: "grace", graceEnd: at(10 * DAY).toISOString() } });
    await member(5 * DAY, { phone: null });
    await member(5 * DAY, { env: "Sandbox" });
    await member(5 * DAY, { env: null });
    await member(23 * HOUR);
    const gone = await member(5 * DAY);
    expect((await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: gone.headers })).statusCode).toBe(204);
    // 注销会删掉会员状态;万一注销后又写进来(见 retention.ts),也不发
    await t.deps.db.insertInto("subscriptions").values({ user_id: gone.userId, data: JSON.stringify(gone.data), original_transaction_id: gone.otid, updated_at: base }).execute();
    expect(await run(base)).toEqual({ due: 0, sent: 0, failed: 0, unknown: 0 });
    expect(sent).toEqual([]);
  });

  it("夜里不发;早上 8 点以后发,收到时离到期还有 5 天以上", async () => {
    // 北京时间 23 点,离到期 5 天 10 小时
    const night = at(13 * HOUR);
    const m = await member(13 * HOUR + 5 * DAY + 10 * HOUR);
    expect(await run(night)).toEqual({ skipped: "quiet_hours", due: 0, sent: 0, failed: 0, unknown: 0 });
    expect((await run(at(21 * HOUR + 59 * 60_000))).skipped).toBe("quiet_hours"); // 北京 7:59
    const morning = at(22 * HOUR); // 北京 8:00
    expect((await run(morning)).sent).toBe(1);
    expect(Date.parse(m.data.periodEnd) - morning.getTime()).toBeGreaterThanOrEqual(5 * DAY);
  });

  it("没配短信模板:不发,日志里说明", async () => {
    await member(5 * DAY);
    expect(await run(base, null)).toEqual({ skipped: "no_template", due: 0, sent: 0, failed: 0, unknown: 0 });
    expect(logs).toEqual(["没有配置扣费提醒短信模板(SMS_RENEWAL_TEMPLATE_CODE),不发扣费前短信"]);
    expect(sent).toEqual([]);
  });

  it("短信服务商明确报错:下一轮再试,最多试 3 次", async () => {
    const m = await member(5 * DAY);
    failWith = new AliyunSmsError("isv.BUSINESS_LIMIT_CONTROL", "触发流控");
    for (let i = 1; i <= 3; i++) {
      expect(await run(at(i * HOUR)), `第 ${i} 次`).toEqual({ due: 1, sent: 0, failed: 1, unknown: 0 });
      expect(await rowsOf(m.userId)).toMatchObject([{ status: "failed", attempts: i, error: "isv.BUSINESS_LIMIT_CONTROL" }]);
    }
    expect(logs.filter((l) => l === "扣费提醒短信发送失败(下一轮再试)")).toHaveLength(3);
    // 试满 3 次就不再试了
    failWith = null;
    expect(await run(at(4 * HOUR))).toEqual({ due: 0, sent: 0, failed: 0, unknown: 0 });
    expect(sent).toEqual([]);
  });

  it("失败一次、下一轮发成功", async () => {
    const m = await member(5 * DAY);
    failWith = new TypeError("fetch failed");
    expect((await run(base)).failed).toBe(1);
    failWith = null;
    expect((await run(at(HOUR))).sent).toBe(1);
    expect(await rowsOf(m.userId)).toMatchObject([{ status: "sent", attempts: 2, error: null }]);
  });

  it("超时:可能已经发出去了,不再重发", async () => {
    const m = await member(5 * DAY);
    failWith = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(await run(base)).toEqual({ due: 1, sent: 0, failed: 0, unknown: 1 });
    failWith = null;
    expect(await run(at(HOUR))).toEqual({ due: 0, sent: 0, failed: 0, unknown: 0 });
    expect(await rowsOf(m.userId)).toMatchObject([{ status: "unknown", attempts: 1, error: "TimeoutError" }]);
  });

  it("两台服务器同时跑:只发一条", async () => {
    const m = await member(5 * DAY);
    delayMs = 20;
    const [a, b] = await Promise.all([run(base), run(base)]);
    expect(a.sent + b.sent).toBe(1);
    expect(sent.map((s) => s.phone)).toEqual([m.phone]);
  });

  it("续费以后的下一期,到时候再发一条", async () => {
    const m = await member(5 * DAY, { sub: { productId: "premium_monthly" } });
    expect((await run(base)).sent).toBe(1);
    // 苹果续费:到期时间顺延一个月
    const next = { ...m.data, periodEnd: at(5 * DAY + 30 * DAY).toISOString() };
    await t.deps.db.updateTable("subscriptions").set({ data: JSON.stringify(next) }).where("user_id", "=", m.userId).execute();
    expect((await run(at(10 * DAY))).sent).toBe(0);
    expect((await run(at(30 * DAY))).sent).toBe(1);
    expect(sent.map((s) => s.params.date)).toEqual([bjDate(m.data.periodEnd), bjDate(next.periodEnd)]);
    expect(await rowsOf(m.userId)).toHaveLength(2);
  });

  it("注销账号:提醒记录留下当凭据,但不再关联这个人", async () => {
    const m = await member(5 * DAY);
    await run(base);
    expect((await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: m.headers })).statusCode).toBe(204);
    expect(await rowsOf(m.userId)).toEqual([]);
    const kept = await t.deps.db.selectFrom("renewal_sms").select(["user_id", "status"]).where("original_transaction_id", "=", m.otid).execute();
    expect(kept).toEqual([{ user_id: null, status: "sent" }]);
  });
});
