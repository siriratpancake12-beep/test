import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testConfig } from "../src/config";
import { createJobs, purgeSlot, renewalSmsSlot, runJob, startJobs, type Job, type JobLog } from "../src/jobs";
import type { SmsNotifier } from "../src/routes/auth";
import { makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 60_000);
afterAll(async () => t?.app.close());

const logs: { level: string; msg: string }[] = [];
const log: JobLog = {
  info: (_o, msg) => logs.push({ level: "info", msg }),
  warn: (_o, msg) => logs.push({ level: "warn", msg }),
  error: (_o, msg) => logs.push({ level: "error", msg }),
};
const notifier: SmsNotifier = { async notify() {} };
const runsOf = (name: string) => t.deps.db.selectFrom("job_runs").select(["slot", "ok", "result"]).where("name", "=", name).orderBy("slot").execute();

describe("时段", () => {
  it("清理每天一次,一天从北京时间凌晨 3 点(UTC 19 点)算起", () => {
    expect(purgeSlot(new Date("2026-11-01T18:59:59Z"))).toBe("2026-10-31");
    expect(purgeSlot(new Date("2026-11-01T19:00:00Z"))).toBe("2026-11-01");
    expect(purgeSlot(new Date("2026-11-02T12:00:00Z"))).toBe("2026-11-01");
  });

  it("扣费前短信:北京时间 8 点到 21 点每小时一次,夜里不跑", () => {
    expect(renewalSmsSlot(new Date("2026-11-01T23:59:00Z"))).toBeNull(); // 北京 7:59
    expect(renewalSmsSlot(new Date("2026-11-02T00:00:00Z"))).toBe("2026-11-02T00"); // 北京 8:00
    expect(renewalSmsSlot(new Date("2026-11-02T12:30:00Z"))).toBe("2026-11-02T12"); // 北京 20:30
    expect(renewalSmsSlot(new Date("2026-11-02T13:00:00Z"))).toBeNull(); // 北京 21:00
  });
});

describe("跑任务", () => {
  it("同一时段只跑一次(几台服务器都有定时器);结果记进 job_runs", async () => {
    let n = 0;
    const job: Job = { name: "test-once", slot: () => "s1", run: async () => ({ deleted: ++n }) };
    const now = () => new Date("2026-11-01T12:00:00Z");
    const [a, b] = await Promise.all([runJob(t.deps.db, job, now, log), runJob(t.deps.db, job, now, log)]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(n).toBe(1);
    expect(await runJob(t.deps.db, job, now, log)).toEqual({ ran: false });
    expect(await runsOf("test-once")).toEqual([{ slot: "s1", ok: true, result: { deleted: 1 } }]);
    // 命令行手动跑:指定自己的时段,不和定时器抢
    expect((await runJob(t.deps.db, job, now, log, "cli:2026-11-01T12:00:00.000Z")).ran).toBe(true);
  });

  it("出错:记日志和 job_runs(ok = false),不抛出;这个时段不再重跑", async () => {
    const job: Job = { name: "test-fail", slot: () => "s1", run: async () => { throw new Error("数据库连不上"); } };
    const now = () => new Date();
    expect(await runJob(t.deps.db, job, now, log)).toEqual({ ran: true, ok: false });
    expect(await runsOf("test-fail")).toEqual([{ slot: "s1", ok: false, result: { error: "数据库连不上" } }]);
    expect(logs.at(-1)).toEqual({ level: "error", msg: "定时任务失败" });
    expect((await runJob(t.deps.db, job, now, log)).ran).toBe(false);
  });

  it("现在不该跑(slot 为 null)就不占时段", async () => {
    const run = vi.fn(async () => null);
    expect(await runJob(t.deps.db, { name: "test-night", slot: () => null, run }, () => new Date(), log)).toEqual({ ran: false });
    expect(run).not.toHaveBeenCalled();
    expect(await runsOf("test-night")).toEqual([]);
  });

  it("服务器里的定时器:启动后跑一轮,之后每隔一段时间看一次,新的时段才再跑;停掉以后不再跑", async () => {
    let slot = "a";
    const runs: string[] = [];
    const job: Job = { name: "test-timer", slot: () => slot, run: async () => { runs.push(slot); return null; } };
    const stop = startJobs({ db: t.deps.db, jobs: [job], now: () => new Date(), log, firstDelayMs: 0, everyMs: 10 });
    await vi.waitFor(() => expect(runs).toEqual(["a"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toEqual(["a"]);
    slot = "b";
    await vi.waitFor(() => expect(runs).toEqual(["a", "b"]));
    stop();
    slot = "c";
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toEqual(["a", "b"]);
  });

  it("没配扣费提醒短信模板:只有清理任务,并在日志里说明", () => {
    logs.length = 0;
    expect(createJobs({ config: testConfig(), db: t.deps.db, notifier, log }).map((j) => j.name)).toEqual(["purge"]);
    expect(logs).toEqual([{ level: "warn", msg: "没有配置扣费提醒短信模板(SMS_RENEWAL_TEMPLATE_CODE):不发扣费前短信,只有 App 内的提醒" }]);
    const config = testConfig();
    const withTemplate = { ...config, sms: { ...config.sms, renewalTemplateCode: "SMS_RENEW_1" } };
    expect(createJobs({ config: withTemplate, db: t.deps.db, notifier, log }).map((j) => j.name)).toEqual(["purge", "renewal-sms"]);
  });
});
