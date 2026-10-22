import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MetricsRes, ROUTES, type Subscription } from "@lingo/core";
import { buildApp } from "../src/app";
import { testConfig } from "../src/config";
import { makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
/** 没配置后台口令的服务器(和 t 共用数据库,省得再建一个 PGlite) */
let closed: FastifyInstance;
beforeAll(async () => {
  t = await makeTestApp();
  closed = await buildApp({ ...t.deps, config: testConfig({ adminToken: null }) });
  await seed();
}, 60_000);
afterAll(async () => {
  await closed?.close();
  await t?.app.close();
});

const ADMIN = { "x-admin-token": "test-admin" };
const metrics = (query: string, headers: Record<string, string> = ADMIN, app: FastifyInstance = t.app) =>
  app.inject({ method: "GET", url: `${ROUTES.adminMetrics}?${query}`, headers });

/**
 * 测试数据(区间 2026-11-01 ~ 11-30,区间最后 7 天是 11-24 ~ 11-30,日期都是 UTC)。
 * u6 在区间前注册;u7 注册后注销了。
 */
const id: Record<string, string> = {};
const users: [string, string, string?][] = [
  ["u1", "2026-11-01T10:00:00Z"],
  ["u2", "2026-11-01T23:30:00Z"],
  ["u3", "2026-11-20T08:00:00Z"],
  ["u4", "2026-11-29T12:00:00Z"],
  ["u5", "2026-11-30T12:00:00Z"],
  ["u6", "2026-10-31T23:00:00Z"],
  ["u7", "2026-11-05T09:00:00Z", "2026-11-06T00:00:00Z"],
];
/** [用户(null = 没登录), anonId, 事件, 时间] */
const events: [string | null, string, string, string][] = [
  ["u1", "a-u1", "lesson_complete", "2026-11-02T09:00:00Z"], // u1 第 1 天
  ["u1", "a-u1", "review_complete", "2026-11-08T12:00:00Z"], // u1 第 7 天
  ["u2", "a-u2", "app_open", "2026-11-02T10:00:00Z"], // 打开不算学习
  ["u2", "a-u2", "lesson_complete", "2026-11-03T01:00:00Z"], // u2 第 2 天(不是第 1 天)
  ["u3", "a-u3", "drill_complete", "2026-11-21T08:00:00Z"], // u3 第 1 天
  ["u4", "a-u4", "lesson_complete", "2026-11-29T13:00:00Z"], // u4 第 0 天
  ["u4", "a-u4", "lesson_complete", "2026-11-30T05:00:00Z"], // u4 第 1 天
  ["u3", "a-u3", "review_complete", "2026-11-25T10:00:00Z"],
  ["u3", "a-u3", "lesson_complete", "2026-11-26T01:00:00Z"],
  ["u3", "a-u3", "lesson_complete", "2026-11-26T23:00:00Z"], // 同一天两次只算一天
  ["u3", "a-u3", "drill_complete", "2026-11-28T12:00:00Z"], // u3 最后 7 天学了 3 天
  ["u2", "a-u2", "review_complete", "2026-11-24T00:00:00Z"],
  ["u2", "a-u2", "review_complete", "2026-11-25T12:00:00Z"],
  ["u2", "a-u2", "review_complete", "2026-11-26T12:00:00Z"], // u2 3 天
  ["u6", "a-u6", "lesson_complete", "2026-11-24T12:00:00Z"],
  ["u6", "a-u6", "lesson_complete", "2026-11-27T12:00:00Z"],
  ["u6", "a-u6", "lesson_complete", "2026-11-30T23:59:00Z"], // u6 3 天
  ["u1", "a-B", "review_complete", "2026-11-28T12:00:00Z"], // u1 在设备 B 上登录过
  ["u1", "a-u1", "review_complete", "2026-11-29T12:00:00Z"],
  ["u1", "a-u1", "review_complete", "2026-11-30T12:00:00Z"], // u1 3 天(但会员已过期)
  [null, "a-B", "lesson_complete", "2026-11-27T12:00:00Z"], // 设备 B 登录前学的:算 u1,不另算一人
  [null, "a-A", "lesson_complete", "2026-11-26T12:00:00Z"], // 从没登录的设备 A:按 anonId 算一人
  [null, "a-C", "app_open", "2026-11-27T12:00:00Z"], // 只打开没学
  ["u5", "a-u5", "lesson_complete", "2026-11-23T23:59:59Z"], // 在最后 7 天之前
];
const sub = (status: Subscription["status"], periodEnd: string, graceEnd?: string): Subscription => ({
  productId: "premium_yearly", platform: "ios", status, periodEnd, ...(graceEnd ? { graceEnd } : {}), autoRenew: true, trialUsed: true, reminders: [],
});
const subscriptions: [string, Subscription][] = [
  ["u1", sub("trial", "2026-11-30T00:00:00.000Z")], // 截止时已过期
  ["u2", sub("grace", "2026-11-26T00:00:00.000Z", "2026-12-05T00:00:00.000Z")], // 宽限期内,算会员
  ["u3", sub("active", "2027-11-20T00:00:00.000Z")],
  ["u4", sub("active", "2027-11-29T00:00:00.000Z")], // 会员但只学了 2 天
  ["u6", sub("active", "2026-12-25T00:00:00.000Z")],
];
const subEvents: [string, string, string][] = [
  ["u1", "start-trial", "2026-11-10T00:00:00Z"],
  ["u1", "start-trial", "2026-11-10T00:00:01Z"], // 交易和通知各记了一条:试用开启数按条数算,转付费按人算
  ["u2", "start-trial", "2026-11-12T00:00:00Z"],
  ["u3", "start-trial", "2026-11-20T00:00:00Z"],
  ["u3", "purchase", "2026-11-20T00:00:00Z"], // 和试用同一时刻:试用本身那笔,不算转付费
  ["u4", "start-trial", "2026-11-26T00:00:00Z"], // 到截止时还没满 7 天
  ["u6", "start-trial", "2026-10-25T00:00:00Z"], // 区间前
  ["u1", "renewed", "2026-11-17T00:00:00Z"], // u1 试用转付费
  ["u6", "renewed", "2026-11-01T00:00:00Z"],
  ["u2", "billing-failed", "2026-11-18T00:00:00Z"],
  ["u2", "expired", "2026-11-19T00:00:00Z"],
  ["u3", "refunded", "2026-11-25T00:00:00Z"],
  ["u6", "renewed", "2026-12-02T00:00:00Z"], // 区间后
];

async function seed() {
  const db = t.deps.db;
  for (const [name, created, deleted] of users) {
    id[name] = randomUUID();
    await db.insertInto("users").values({
      id: id[name]!, phone: deleted ? null : `1380000000${name.slice(1)}`, apple_sub: null, wechat_unionid: null, wechat_openid: null,
      created_at: new Date(created), deleted_at: deleted ? new Date(deleted) : null,
    }).execute();
  }
  await db.insertInto("events").values(events.map(([u, anon, name, at], i) => ({
    id: `m_${i}`, user_id: u ? id[u]! : null, anon_id: anon, name, at: new Date(at), received_at: new Date(at), lang: "de", props: "{}", platform: "ios", app_version: "1.0.0",
  }))).execute();
  for (const [u, s] of subscriptions) {
    await db.insertInto("subscriptions").values({ user_id: id[u]!, data: JSON.stringify(s), original_transaction_id: `otx-${u}`, updated_at: new Date() }).execute();
  }
  await db.insertInto("subscription_events").values(subEvents.map(([u, type, at], i) => ({
    id: `se_${i}`, user_id: id[u]!, type, product_id: "premium_yearly", at: new Date(at), source: "test", raw: null,
  }))).execute();
}

describe("后台指标", () => {
  it("要后台口令;没配置口令时后台关闭", async () => {
    expect((await metrics("from=2026-11-01&to=2026-11-30", {})).statusCode).toBe(403);
    const wrong = await metrics("from=2026-11-01&to=2026-11-30", { "x-admin-token": "guess" });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe("forbidden");
    expect((await metrics("from=2026-11-01&to=2026-11-30", ADMIN, closed)).statusCode).toBe(403);
  });

  it("日期参数不对:400 中文提示", async () => {
    const cases: [string, string][] = [
      ["", "请选择开始和结束日期(YYYY-MM-DD)"],
      ["from=2026-11-01", "请选择开始和结束日期(YYYY-MM-DD)"],
      ["from=2026-1-1&to=2026-11-30", "日期格式应为 YYYY-MM-DD"],
      ["from=2026-02-30&to=2026-03-30", "日期不存在"],
      ["from=2026-11-30&to=2026-11-01", "开始日期不能晚于结束日期"],
      ["from=2025-01-01&to=2026-11-30", "日期范围最多一年"],
    ];
    for (const [q, message] of cases) {
      const r = await metrics(q);
      expect(r.statusCode, q).toBe(400);
      expect(r.json().error.message, q).toBe(message);
    }
  });

  it("按定义算出各项指标", async () => {
    t.setNow(new Date("2026-12-15T00:00:00Z"));
    const r = await metrics("from=2026-11-01&to=2026-11-30");
    expect(r.statusCode).toBe(200);
    const m = MetricsRes.parse(r.json());
    expect(m).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
      // 注销的 u7 也是区间内注册的
      newUsers: 6,
      retention: {
        // 样本 u1 u2 u3 u4(u5 的第 1 天在区间外,u7 已注销),第 1 天学了的:u1 u3 u4
        d1: 3 / 4,
        // 样本 u1 u2 u3(注册早于 to 至少 7 天),第 7 天学了的:u1
        d7: 1 / 3,
        // 没有注册早于 to 30 天的人
        d30: null,
      },
      // u1(含设备 B 登录前的)、u2、u3、u4、u6、设备 A
      weeklyActiveLearners: 6,
      // 学了 3 天的 u1 u2 u3 u6 里,截止时是会员的:u2(宽限期)u3 u6
      northStar: 3,
      // 区间内 start-trial 的条数
      trialStarts: 5,
      // 满 7 天的试用 u1 u2 u3,之后付费的 u1
      trialToPaid: 1 / 3,
      // 续费 2,到期 1
      renewalRate: 2 / 3,
      // 退款 1 ÷(购买 1 + 续费 2)
      refundRate: 1 / 3,
    });
  });

  it("区间包含今天:第 N 天还没过完的人不进留存样本", async () => {
    t.setNow(new Date("2026-11-30T12:00:00Z"));
    const m = MetricsRes.parse((await metrics("from=2026-11-01&to=2026-11-30")).json());
    // u4 的第 1 天(11-30)还没过完
    expect(m.retention.d1).toBe(2 / 3);
    expect(m.trialToPaid).toBe(1 / 3);
  });

  it("没有数据的区间:人数是 0,比例是 null", async () => {
    t.setNow(new Date("2026-12-15T00:00:00Z"));
    const m = MetricsRes.parse((await metrics("from=2025-06-01&to=2025-06-30")).json());
    expect(m).toEqual({
      from: "2025-06-01", to: "2025-06-30", newUsers: 0, retention: { d1: null, d7: null, d30: null },
      weeklyActiveLearners: 0, northStar: 0, trialStarts: 0, trialToPaid: null, renewalRate: null, refundRate: null,
    });
  });
});

describe("后台页面", () => {
  it("GET /admin 返回页面;只允许页面自带的脚本运行", async () => {
    const r = await t.app.inject({ method: "GET", url: "/admin" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain("<title>语途后台 · 指标</title>");
    expect(r.body).toContain("sessionStorage");
    expect(r.body).toContain(ROUTES.adminMetrics);
    const script = /<script>([\s\S]*?)<\/script>/.exec(r.body)![1]!;
    const hash = createHash("sha256").update(script).digest("base64");
    expect(r.headers["content-security-policy"]).toContain(`script-src 'sha256-${hash}'`);
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("没配置后台口令时页面也不给", async () => {
    expect((await closed.inject({ method: "GET", url: "/admin" })).statusCode).toBe(404);
  });
});
