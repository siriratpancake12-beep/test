import { describe, expect, it } from "vitest";
import { goalMet, settleFreezes, streak } from "../src/habit";
import { engagement } from "../src/learner";
import { addStudyTime, emptyProgress, recordAnswer, type Progress } from "../src/session";

/** 北京时间某天晚上 8 点 */
const at = (day: string) => new Date(`${day}T20:00:00+08:00`);
const study = (p: Progress, day: string, n = 5) => {
  for (let i = 0; i < n; i++) p = recordAnswer(p, { verdict: "correct", skill: "speak", ms: 10_000 }, at(day));
  return p;
};
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-11-${String(from + i).padStart(2, "0")}`);

describe("连续天数与保护卡", () => {
  it("只答一两道题不算学过", () => {
    const p = study(emptyProgress("de"), "2026-11-01", 2);
    expect(streak(p, at("2026-11-01"))).toBe(0);
  });

  it("连续 7 天送一张保护卡,最多两张", () => {
    let p = emptyProgress("de");
    for (const d of days(1, 7)) p = study(p, d);
    expect(streak(p, at("2026-11-07"))).toBe(7);
    expect(p.freezes).toBe(1);
    for (const d of days(8, 21)) p = study(p, d);
    expect(p.freezes).toBe(2);
    for (const d of days(22, 28)) p = study(p, d);
    expect(p.freezes).toBe(2);
  });

  it("漏学一天,回来学的时候自动用保护卡,连续天数不断", () => {
    let p = emptyProgress("de");
    for (const d of days(1, 7)) p = study(p, d);
    p = study(p, "2026-11-09");
    expect(p.freezes).toBe(0);
    expect(p.frozenDays).toEqual(["2026-11-08"]);
    expect(streak(p, at("2026-11-09"))).toBe(8);
  });

  it("漏的天数比保护卡多:连续天数重来,保护卡留着", () => {
    let p = emptyProgress("de");
    for (const d of days(1, 7)) p = study(p, d);
    p = study(p, "2026-11-10");
    expect(p.freezes).toBe(1);
    expect(streak(p, at("2026-11-10"))).toBe(1);
  });

  it("今天还没学,连续天数算到昨天;结算可以重复调用", () => {
    let p = emptyProgress("de");
    for (const d of days(1, 3)) p = study(p, d);
    expect(streak(p, at("2026-11-04"))).toBe(3);
    expect(settleFreezes(settleFreezes(p, at("2026-11-05")), at("2026-11-05"))).toEqual(settleFreezes(p, at("2026-11-05")));
  });

  it("从北京飞到柏林:以前按北京时间记的日子比当地今天晚,不能当成没学", () => {
    let p = emptyProgress("de");
    for (const d of days(1, 2)) p = study(p, d);
    // 北京时间 11 月 3 日凌晨 1 点又学了一次(记在 11-03)
    for (let i = 0; i < 5; i++) p = recordAnswer(p, { verdict: "correct", skill: "speak" }, new Date("2026-11-03T01:00:00+08:00"));
    // 到了柏林,时区换成 UTC+1;当地还是 11 月 2 日晚上
    p = { ...p, tz: 60 };
    const berlin = new Date("2026-11-02T19:00:00+01:00");
    expect(streak(p, berlin)).toBe(3);
    expect(engagement(p, berlin).daysAway).toBe(0);
    // 当地时间接着学,记到同一天,不会出现"倒退一天"
    p = recordAnswer(p, { verdict: "correct", skill: "speak" }, berlin);
    expect(Object.keys(p.log).sort()).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  it("每日目标按分钟算", () => {
    let p: Progress = { ...emptyProgress("de"), goal: { kind: "travel" as const, target: "A1" as const, dailyMinutes: 10 } };
    p = addStudyTime(p, at("2026-11-01"), 9 * 60);
    expect(goalMet(p, at("2026-11-01"))).toBe(false);
    p = addStudyTime(p, at("2026-11-01"), 60);
    expect(goalMet(p, at("2026-11-01"))).toBe(true);
  });
});
