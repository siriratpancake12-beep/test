import { describe, expect, it } from "vitest";
import { studyReminders } from "../src/remind";
import { weeklyReport } from "../src/report";
import { completeLesson, emptyProgress, recordAnswer, type Progress } from "../src/session";
import { applySubEvent, canAccessLesson, isPremium, renewalReminder, softPaywallAllowed, type Subscription } from "../src/subscription";
import { lessons } from "./fixtures";

const de = lessons("de");
const at = (day: string, h = 20) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00+08:00`);
const article = { kind: "article", expected: "der", got: "die" } as const;

function answers(p: Progress, now: Date, n: number, mistakes: number) {
  for (let i = 0; i < n; i++) {
    const wrong = i < mistakes;
    p = recordAnswer(p, { itemId: "de.vater", direction: "produce", verdict: wrong ? "wrong" : "correct", ms: 6000, ...(wrong ? { issues: [article] } : {}) }, now);
  }
  return p;
}

describe("周报", () => {
  it("本周学会的事、学习量、正确率对比、改掉的错误", () => {
    let p = emptyProgress("de");
    p = answers(p, at("2026-11-02"), 20, 8); // 上周:冠词错 8 次
    p = completeLesson(p, de[0]!, at("2026-11-10"));
    p = completeLesson(p, de[1]!, at("2026-11-11"));
    p = answers(p, at("2026-11-11"), 20, 1); // 本周:只错 1 次
    const r = weeklyReport(p, de, at("2026-11-12"));
    expect(r.from).toBe("2026-11-06");
    expect(r.canDo).toEqual(["能用德语跟人打招呼,说出自己叫什么、从哪里来", "能用德语介绍自己的家人"]);
    expect(r.activeDays).toBe(2);
    expect(r.answers).toBe(20);
    expect(r.accuracy).toBeCloseTo(0.95);
    expect(r.prevAccuracy).toBeCloseTo(0.6);
    expect(r.improved).toMatchObject({ kind: "article", lastWeek: 8, thisWeek: 1 });
    expect(r.newItems).toBe(12);
  });

  it("没学也能出周报", () => {
    const r = weeklyReport(emptyProgress("de"), de, at("2026-11-12"));
    expect(r.accuracy).toBeNull();
    expect(r.canDo).toEqual([]);
    expect(r.focus).toBeUndefined();
  });
});

describe("订阅", () => {
  const t0 = new Date("2026-11-01T12:00:00Z");
  const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);
  const trial = applySubEvent(null, { type: "start-trial", productId: "premium_yearly", platform: "ios", at: t0 })!;

  it("年度会员试用 7 天,每个账号只能试用一次;月度没有试用", () => {
    expect(trial.status).toBe("trial");
    expect(isPremium(trial, day(6))).toBe(true);
    expect(isPremium(trial, day(8))).toBe(false);
    const again = applySubEvent({ ...trial, status: "expired" }, { type: "start-trial", productId: "premium_yearly", platform: "ios", at: day(30) });
    expect(again?.status).toBe("expired");
    expect(applySubEvent(null, { type: "start-trial", productId: "premium_monthly", platform: "ios", at: t0 })).toBeNull();
  });

  it("续费、扣费失败的宽限期、过期、退款", () => {
    let s: Subscription | null = applySubEvent(trial, { type: "purchase", productId: "premium_yearly", platform: "ios", at: day(7), periodEnd: day(372) });
    expect(s).toMatchObject({ status: "active", trialUsed: true });
    s = applySubEvent(s, { type: "billing-failed", at: day(372), graceEnd: day(388) });
    expect(isPremium(s, day(380))).toBe(true);
    expect(isPremium(s, day(390))).toBe(false);
    s = applySubEvent(s, { type: "renewed", at: day(381), periodEnd: day(737) });
    expect(s).toMatchObject({ status: "active" });
    expect(s?.graceEnd).toBeUndefined();
    expect(isPremium(applySubEvent(s, { type: "refunded", at: day(400) }), day(401))).toBe(false);
  });

  it("扣费前 5 天、前 1 天各提醒一次;关了自动续费就不提醒", () => {
    expect(renewalReminder(trial, day(1))).toBeNull();
    const r5 = renewalReminder(trial, day(2.5))!;
    expect(r5).toMatchObject({ kind: "trial-ending", daysLeft: 5, priceCny: 298 });
    expect(r5.zh).toMatch(/自动续费.*随时.*取消/);
    const reminded = applySubEvent(trial, { type: "reminded", key: r5.key, at: day(2.5) });
    expect(renewalReminder(reminded, day(3))).toBeNull();
    expect(renewalReminder(reminded, day(6.5))).toMatchObject({ daysLeft: 1 });
    expect(renewalReminder(applySubEvent(trial, { type: "auto-renew", on: false, at: day(1) }), day(6.5))).toBeNull();
  });

  it("第一单元免费,其余要会员;复习不受限制(不在这里判断)", () => {
    expect(canAccessLesson(de[1]!, de, false)).toBe(true);
    const later = { ...de[1]!, id: "de.a1u2.l01", unit: "A1-2", order: de[1]!.order + 1000 };
    expect(canAccessLesson(later, [...de, later], false)).toBe(false);
    expect(canAccessLesson(later, [...de, later], true)).toBe(true);
    // 分级测试后起步在 A1-2 的人,免费的是 A1-2
    expect(canAccessLesson(later, [...de, later], false, "A1-2")).toBe(true);
    expect(canAccessLesson(de[0]!, [...de, later], false, "A1-2")).toBe(false);
  });

  it("付费介绍最多 3 天出现一次", () => {
    expect(softPaywallAllowed(null, t0)).toBe(true);
    expect(softPaywallAllowed(day(-2).toISOString(), t0)).toBe(false);
    expect(softPaywallAllowed(day(-3).toISOString(), t0)).toBe(true);
  });
});

describe("学习提醒", () => {
  it("排未来 3 天,在习惯的时间;今天目标完成了就不提醒今天", () => {
    let p: Progress = { ...emptyProgress("de"), goal: { kind: "travel" as const, target: "A1" as const, dailyMinutes: 1 } };
    for (let i = 0; i < 3; i++) p = recordAnswer(p, { verdict: "correct", skill: "speak", ms: 0 }, at("2026-11-01", 7));
    const next = studyReminders(p, at("2026-11-02", 6));
    expect(next.map((r) => r.at.toISOString())).toEqual(["2026-11-01T23:00:00.000Z", "2026-11-02T23:00:00.000Z", "2026-11-03T23:00:00.000Z"]);
    expect(next[2]!.body).toMatch(/好几天没见/);
    p = recordAnswer(p, { verdict: "correct", skill: "speak", ms: 60_000 }, at("2026-11-02", 6));
    expect(studyReminders(p, at("2026-11-02", 6))).toHaveLength(2);
  });
});
