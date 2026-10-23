import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type Subscription } from "@lingo/core";
import { monthsBefore, purgeExpired, yearsBefore } from "../src/jobs/retention";
import { createUser, makeTestApp, type TestApp } from "./helpers";

/**
 * 保存期限(《隐私政策》第三节)的清理任务。时钟拨到 2029 年,3 年前的交易记录才有得删。
 * 每个测试用自己的 id 前缀,只检查自己插入的行。
 */
const NOW = new Date("2029-06-15T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
  t.setNow(NOW);
}, 60_000);
afterAll(async () => t?.app.close());
const db = () => t.deps.db;

const event = (id: string, receivedAt: Date, userId: string | null = null, at = receivedAt) => ({
  id, user_id: userId, anon_id: "anon_retention", name: "app_open", at, received_at: receivedAt,
  lang: null, props: "{}", platform: "ios", app_version: "1.0.0",
});
const ids = async (table: "events" | "subscription_events" | "apple_notifications" | "sms_codes" | "renewal_sms", prefix: string) =>
  (await db().selectFrom(table).select("id").where("id", "like", `${prefix}%`).orderBy("id").execute()).map((r) => r.id);

const sub: Subscription = { productId: "premium_yearly", platform: "ios", status: "active", periodEnd: "2030-01-01T00:00:00.000Z", autoRenew: true, trialUsed: true, reminders: [] };

describe("日期往前推", () => {
  it("按日历月、年;2 月 29 日往前推到平年是 3 月 1 日(只会多留,不会提前删)", () => {
    expect(monthsBefore(new Date("2029-06-15T12:00:00Z"), 24).toISOString()).toBe("2027-06-15T12:00:00.000Z");
    expect(yearsBefore(new Date("2029-06-15T12:00:00Z"), 3).toISOString()).toBe("2026-06-15T12:00:00.000Z");
    expect(yearsBefore(new Date("2028-02-29T00:00:00Z"), 3).toISOString()).toBe("2025-03-01T00:00:00.000Z");
  });
});

describe("按保存期限清理", () => {
  it("使用统计:服务器收到满 24 个月的删掉(提前 1 天),没到的留着;离线很久才上传的从收到那天算", async () => {
    const cutoff = monthsBefore(NOW, 24).getTime();
    await db().insertInto("events").values([
      event("ret_ev_1_old", new Date(cutoff - DAY)),
      event("ret_ev_2_margin", new Date(cutoff + 12 * 3_600_000)),
      event("ret_ev_3_keep", new Date(cutoff + 2 * DAY)),
      event("ret_ev_4_recent", ago(DAY)),
      // 两年多以前学的,上个月才联网上传
      event("ret_ev_5_late", ago(30 * DAY), null, new Date(cutoff - 100 * DAY)),
    ]).execute();
    const r = await purgeExpired(db(), NOW);
    expect(r.events).toBe(2);
    expect(await ids("events", "ret_ev_")).toEqual(["ret_ev_3_keep", "ret_ev_4_recent", "ret_ev_5_late"]);
  });

  it("埋点很多时分批删,一次删完", async () => {
    await db().insertInto("events").values(Array.from({ length: 7 }, (_, i) => event(`ret_batch_${i}`, ago(800 * DAY)))).execute();
    expect((await purgeExpired(db(), NOW, { batch: 3 })).events).toBe(7);
    expect(await ids("events", "ret_batch_")).toEqual([]);
  });

  it("AI 用量只记次数,按使用统计的期限删", async () => {
    const u = randomUUID();
    await db().insertInto("ai_usage").values([
      { user_id: u, day: "2027-06-15", kind: "tutor", count: 3 },
      { user_id: u, day: "2027-06-17", kind: "tutor", count: 2 },
      { user_id: u, day: "2029-06-14", kind: "speech", count: 9 },
    ]).execute();
    const r = await purgeExpired(db(), NOW);
    expect(r.aiUsage).toBe(1);
    expect((await db().selectFrom("ai_usage").select("day").where("user_id", "=", u).orderBy("day").execute()).map((x) => x.day)).toEqual(["2027-06-17", "2029-06-14"]);
  });

  it("验证码的发送记录(手机号、IP)两天后删,没人再发验证码时也删", async () => {
    const row = (id: string, createdAt: Date) => ({
      id, phone: "13700001111", code_hash: "00", ip: "203.0.113.9", created_at: createdAt, expires_at: new Date(createdAt.getTime() + 300_000), attempts: 0, used_at: null,
    });
    await db().insertInto("sms_codes").values([row("ret_sms_old", ago(2 * DAY + 1000)), row("ret_sms_new", ago(DAY))]).execute();
    expect((await purgeExpired(db(), NOW)).smsCodes).toBe(1);
    expect(await ids("sms_codes", "ret_sms_")).toEqual(["ret_sms_new"]);
  });

  it("交易记录按订阅算:最后一笔交易和最后一期都结束满 3 年才删;还在续的订阅,早年的流水留着", async () => {
    const tx = (id: string, otid: string | null, at: string, periodEnd: string | null, type = "renewed") => ({
      id, user_id: null, type, product_id: "premium_yearly", at: new Date(at), source: "test", raw: null,
      original_transaction_id: otid, period_end: periodEnd ? new Date(periodEnd) : null, event: null, environment: "Production",
    });
    const note = (id: string, otid: string | null, signedAt: string) => ({
      id, type: "DID_RENEW", subtype: null, original_transaction_id: otid, user_id: null, environment: "Production", signed_at: new Date(signedAt), raw: null,
    });
    await db().insertInto("subscription_events").values([
      // A:2026 年 1 月就结束了 → 全删
      tx("ret_tx_a1", "otx-ret-a", "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "purchase"),
      tx("ret_tx_a2", "otx-ret-a", "2026-01-02T00:00:00Z", null, "expired"),
      // B:2025 年买的,一直续到现在 → 2025 年那笔也留着(恢复购买、换绑时要用它重建会员状态)
      tx("ret_tx_b1", "otx-ret-b", "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "purchase"),
      tx("ret_tx_b2", "otx-ret-b", "2029-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
      // C:交易在 3 年前,但那一期 2026 年 7 月才结束 → 还不到
      tx("ret_tx_c1", "otx-ret-c", "2025-07-01T00:00:00Z", "2026-07-01T00:00:00Z", "purchase"),
      // 没有原始交易 id 的按自己的时间
      tx("ret_tx_x_old", null, "2026-01-01T00:00:00Z", null),
      tx("ret_tx_x_new", null, "2027-01-01T00:00:00Z", null),
    ]).execute();
    await db().insertInto("apple_notifications").values([
      note("ret_an_a", "otx-ret-a", "2026-01-02T00:00:00Z"),
      note("ret_an_b", "otx-ret-b", "2025-01-01T00:00:00Z"),
      // 苹果的测试通知(没有交易)
      note("ret_an_test_old", null, "2026-06-01T00:00:00Z"),
      note("ret_an_test_new", null, "2026-07-01T00:00:00Z"),
    ]).execute();
    await db().insertInto("subscription_rebinds").values([
      { id: "ret_rb_a", original_transaction_id: "otx-ret-a", old_user_id: "deleted", new_user_id: randomUUID(), source: "apple-transaction", at: new Date("2025-06-01T00:00:00Z") },
      { id: "ret_rb_b", original_transaction_id: "otx-ret-b", old_user_id: "deleted", new_user_id: randomUUID(), source: "apple-transaction", at: new Date("2025-06-01T00:00:00Z") },
    ]).execute();
    // A 的会员状态跟着账号走,不删
    const owner = await createUser(t);
    await db().insertInto("subscriptions").values({ user_id: owner.userId, data: JSON.stringify({ ...sub, status: "expired" }), original_transaction_id: "otx-ret-a", updated_at: NOW }).execute();

    const r = await purgeExpired(db(), NOW);
    expect(r.transactions).toEqual({ subscriptions: 1, events: 3, notifications: 2, rebinds: 1 });
    expect(await ids("subscription_events", "ret_tx_")).toEqual(["ret_tx_b1", "ret_tx_b2", "ret_tx_c1", "ret_tx_x_new"]);
    expect(await ids("apple_notifications", "ret_an_")).toEqual(["ret_an_b", "ret_an_test_new"]);
    expect((await db().selectFrom("subscription_rebinds").select("id").where("id", "like", "ret_rb_%").execute()).map((x) => x.id)).toEqual(["ret_rb_b"]);
    expect(await db().selectFrom("subscriptions").select("user_id").where("user_id", "=", owner.userId).execute()).toHaveLength(1);
  });

  it("扣费提醒记录按那一期删(3 年);定时任务的运行记录留一年", async () => {
    const sms = (id: string, periodEnd: Date) => ({
      id, user_id: null, original_transaction_id: null, period_end: periodEnd, product_id: "premium_yearly", price_cny: 298,
      status: "sent", attempts: 1, error: null, created_at: periodEnd, updated_at: periodEnd, sent_at: periodEnd,
    });
    await db().insertInto("renewal_sms").values([sms("ret_rs_old", yearsBefore(ago(DAY), 3)), sms("ret_rs_new", yearsBefore(ago(-DAY), 3))]).execute();
    await db().insertInto("job_runs").values([
      { name: "purge", slot: "ret-old", started_at: ago(366 * DAY), finished_at: null, ok: true, result: null },
      { name: "purge", slot: "ret-new", started_at: ago(300 * DAY), finished_at: null, ok: true, result: null },
    ]).execute();
    const r = await purgeExpired(db(), NOW);
    expect(r.renewalSms).toBe(1);
    expect(r.jobRuns).toBe(1);
    expect(await ids("renewal_sms", "ret_rs_")).toEqual(["ret_rs_new"]);
    expect((await db().selectFrom("job_runs").select("slot").where("slot", "like", "ret-%").execute()).map((x) => x.slot)).toEqual(["ret-new"]);
  });

  it("注销账号的残留:注销以后又写进来的进度、AI 用量、埋点、会员状态、苹果令牌,第二天清掉;别人的不动", async () => {
    const gone = await createUser(t, { phone: "13700002222" });
    const alive = await createUser(t, { phone: "13700003333" });
    expect((await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: gone.headers })).statusCode).toBe(204);
    // 注销那一刻还在进行的请求写进来的(两个人各一份)
    for (const u of [gone.userId, alive.userId]) {
      await db().insertInto("progress").values({ user_id: u, lang: "de", data: null, rev: 1, updated_at: NOW }).execute();
      await db().insertInto("ai_usage").values({ user_id: u, day: "2029-06-15", kind: "tutor", count: 1 }).execute();
      await db().insertInto("events").values(event(`ret_res_${u}`, NOW, u)).execute();
      await db().insertInto("subscriptions").values({ user_id: u, data: JSON.stringify(sub), original_transaction_id: `otx-res-${u}`, updated_at: NOW }).execute();
      await db().insertInto("subscription_events").values({
        id: `ret_res_se_${u}`, user_id: u, type: "renewed", product_id: "premium_yearly", at: NOW, source: "test", raw: null,
        original_transaction_id: `otx-res-${u}`, period_end: new Date("2030-01-01T00:00:00Z"), event: null, environment: "Production",
      }).execute();
      await db().insertInto("renewal_sms").values({
        id: `ret_res_rs_${u}`, user_id: u, original_transaction_id: null, period_end: new Date("2030-01-01T00:00:00Z"), product_id: "premium_yearly", price_cny: 298,
        status: "sent", attempts: 1, error: null, created_at: NOW, updated_at: NOW, sent_at: NOW,
      }).execute();
    }
    await db().updateTable("users").set({ apple_refresh_token: "rt-late" }).where("id", "=", gone.userId).execute();

    const r = await purgeExpired(db(), NOW);
    expect(r.deletedAccounts).toEqual({ identities: 1, progress: 1, aiUsage: 1, events: 1, billing: 1, renewalSms: 1 });
    expect(await db().selectFrom("users").select(["phone", "apple_refresh_token"]).where("id", "=", gone.userId).executeTakeFirst()).toEqual({ phone: null, apple_refresh_token: null });
    const left = async (u: string) => ({
      progress: (await db().selectFrom("progress").select("user_id").where("user_id", "=", u).execute()).length,
      aiUsage: (await db().selectFrom("ai_usage").select("user_id").where("user_id", "=", u).execute()).length,
      events: (await db().selectFrom("events").select("id").where("user_id", "=", u).execute()).length,
      subscriptions: (await db().selectFrom("subscriptions").select("user_id").where("user_id", "=", u).execute()).length,
      subEvents: (await db().selectFrom("subscription_events").select("id").where("user_id", "=", u).execute()).length,
      renewalSms: (await db().selectFrom("renewal_sms").select("id").where("user_id", "=", u).execute()).length,
    });
    expect(await left(gone.userId)).toEqual({ progress: 0, aiUsage: 0, events: 0, subscriptions: 0, subEvents: 0, renewalSms: 0 });
    expect(await left(alive.userId)).toEqual({ progress: 1, aiUsage: 1, events: 1, subscriptions: 1, subEvents: 1, renewalSms: 1 });
    // 埋点、交易流水、提醒记录本身还在(统计、对账要用),只是不再关联这个人
    expect(await db().selectFrom("events").select("user_id").where("id", "=", `ret_res_${gone.userId}`).executeTakeFirst()).toEqual({ user_id: null });
    expect(await db().selectFrom("subscription_events").select("user_id").where("id", "=", `ret_res_se_${gone.userId}`).executeTakeFirst()).toEqual({ user_id: null });
    expect(await db().selectFrom("users").select("phone").where("id", "=", alive.userId).executeTakeFirst()).toEqual({ phone: "13700003333" });
  });

  it("可以重复执行:再跑一次什么都不删", async () => {
    await purgeExpired(db(), NOW);
    expect(await purgeExpired(db(), NOW)).toEqual({
      events: 0, aiUsage: 0, smsCodes: 0, transactions: { subscriptions: 0, events: 0, notifications: 0, rebinds: 0 }, renewalSms: 0, jobRuns: 0,
      deletedAccounts: { identities: 0, progress: 0, aiUsage: 0, events: 0, billing: 0, renewalSms: 0 },
    });
  });
});
