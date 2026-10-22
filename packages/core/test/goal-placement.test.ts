import { describe, expect, it } from "vitest";
import { levelProgress, projection } from "../src/goal";
import { applyPlacement, levelPassed, placementLevels, placementQuestions } from "../src/placement";
import { Lesson, LanguagePack } from "../src/schema";
import { addStudyTime, completeLesson, emptyProgress, isUnlocked, nextLesson, todaysReview, type Progress } from "../src/session";
import { lessons, pack } from "./fixtures";

const de = lessons("de");
const at = (day: string) => new Date(`${day}T20:00:00+08:00`);

/** 造一门有 A1、A2 两级的小课程 */
function twoLevels(): Lesson[] {
  const a2 = de.map((l, i) => Lesson.parse({
    ...l,
    id: `de.a2u1.l0${i + 1}`,
    cefr: "A2",
    unit: "A2-1",
    order: 10 + i,
    newItems: l.newItems.map((it) => ({ ...it, id: `${it.id}_a2` })),
    reviewItems: [],
    lines: [],
  }));
  return [...de, ...a2];
}

describe("目标与预估", () => {
  it("没设目标就不预估", () => {
    expect(projection(emptyProgress("de"), pack("de"), de, at("2026-11-01"))).toBeNull();
  });

  it("按每天目标估达成日期;有截止日期时算出需要每天学多久", () => {
    const p = { ...emptyProgress("de"), goal: { kind: "study-abroad" as const, target: "A1" as const, dailyMinutes: 30, deadline: "2027-02-01" } };
    const pr = projection(p, pack("de"), de, at("2026-11-01"))!;
    expect(pr.totalHours).toBe(80);
    expect(pr.basedOnHistory).toBe(false);
    // 80 小时 ÷ (30 分钟 × 6/7) ≈ 186.7 天 → 187 天
    expect(pr.etaDay).toBe("2027-05-07");
    expect(pr.onTrack).toBe(false);
    expect(pr.daysLeft).toBe(92);
    expect(pr.neededMinutes).toBe(61);
    expect(pr.milestones).toEqual([{ level: "A1", etaDay: "2027-05-07" }]);
  });

  it("里程碑:目标 B1 时,沿途的 A1、A2 也给出日期", () => {
    // 正好 21 分钟 × 6/7 = 每天 18 分钟,数字好算
    const p: Progress = { ...emptyProgress("de"), goal: { kind: "study-abroad", target: "B1", dailyMinutes: 21 } };
    const pr = projection(p, pack("de"), de, at("2026-11-01"))!;
    // pre-A1 不算里程碑(对学习者没意义)
    expect(pr.milestones.map((m) => m.level)).toEqual(["A1", "A2", "B1"]);
    // A1 80 小时 = 4800 分钟 ÷ 18 = 266.7 → 267 天
    expect(pr.milestones[0]).toEqual({ level: "A1", etaDay: "2027-07-26" });
    expect(pr.milestones.at(-1)!.etaDay).toBe(pr.etaDay);
  });

  it("语言包可以覆盖默认学时", () => {
    const custom = LanguagePack.parse({ ...pack("de"), hoursToLevel: { A1: 60 } });
    const p = { ...emptyProgress("de"), goal: { kind: "travel" as const, target: "A1" as const, dailyMinutes: 20 } };
    expect(projection(p, custom, de, at("2026-11-01"))!.totalHours).toBe(60);
  });

  it("学了 5 天以上用真实节奏", () => {
    let p: Progress = { ...emptyProgress("de"), goal: { kind: "travel" as const, target: "A1" as const, dailyMinutes: 60 } };
    for (const d of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]) {
      p = completeLesson(p, de[0]!, at(d));
      p = addStudyTime(p, at(d), 14 * 60);
    }
    const pr = projection(p, pack("de"), de, at("2026-11-05"))!;
    expect(pr.basedOnHistory).toBe(true);
    expect(pr.minutesPerDay).toBeCloseTo(5);
    expect(pr.doneHours).toBeCloseTo(70 / 60);
  });

  it("各等级进度", () => {
    const p = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
    expect(levelProgress(p, twoLevels())).toEqual([{ level: "A1", total: 2, done: 1 }, { level: "A2", total: 2, done: 0 }]);
  });
});

describe("分级测试", () => {
  it("按等级出题,每题有正确答案", () => {
    const all = twoLevels();
    expect(placementLevels(all)).toEqual(["A1", "A2"]);
    const qs = placementQuestions(all, pack("de"), "A1", 3, 6);
    expect(qs).toHaveLength(6);
    expect(qs.every((q) => (q.type === "choose-meaning" || q.type === "listen-choose") && q.answer >= 0)).toBe(true);
  });

  it("80% 才算通过", () => {
    expect(levelPassed(5, 6)).toBe(true);
    expect(levelPassed(4, 6)).toBe(false);
    expect(levelPassed(0, 0)).toBe(false);
  });

  it("通过 A1:A1 的课跳过、直接从 A2 学;词条进复习但不算今天的学习量", () => {
    const all = twoLevels();
    const p = applyPlacement(emptyProgress("de"), all, ["A1"], at("2026-11-01"));
    expect(p.skipped).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
    expect(p.completed).toEqual({});
    expect(nextLesson(all, p)?.id).toBe("de.a2u1.l01");
    expect(isUnlocked(all, p, "de.a2u1.l01")).toBe(true);
    expect(p.log).toEqual({});
    // 免费单元是跳级后起步的单元
    expect(p.freeUnit).toBe("A2-1");
    // 产出方向是新卡,会在之后的复习里出现
    expect(todaysReview(p, at("2026-11-01"), 50, 50).every((c) => c.direction === "produce")).toBe(true);
  });
});
