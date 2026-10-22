import { describe, expect, it } from "vitest";
import {
  checkpointLessonId, checkpointQuestions, courseUnits, goalReached, nextGoals, pendingCheckpoint, scoreCheckpoint,
  unitCheckpoint, unitLabel, unitOfLesson, unitPracticeQuestions,
} from "../src/checkpoint";
import { checkReorder, type Exercise } from "../src/exercises";
import type { Verdict } from "../src/grading";
import { Lesson } from "../src/schema";
import { completeLesson, emptyProgress, recordCheckpoint, type Progress } from "../src/session";
import { lessons, pack } from "./fixtures";

const de = lessons("de"), fr = lessons("fr"), en = lessons("en");
const pool = (ls: Lesson[]) => ls.flatMap((l) => l.newItems);
const at = (day: string) => new Date(`${day}T20:00:00+08:00`);
const withGoal = (target: "A1" | "A2" | "B1" | "C1"): Progress => ({ ...emptyProgress("de"), goal: { kind: "study-abroad", target, dailyMinutes: 15, deadline: "2027-06-01" } });
const finishAll = (p: Progress, ls: Lesson[], day = "2026-11-01") => ls.reduce((acc, l) => completeLesson(acc, l, at(day)), p);

/** 同一个方向考到的词 */
const byDirection = (qs: Exercise[]) => {
  const out: Record<string, string[]> = {};
  for (const q of qs) if ("itemId" in q) (out[q.direction] ??= []).push(q.itemId);
  return out;
};

describe("单元", () => {
  it("按单元分组;单元名拆成编号和主题", () => {
    const units = courseUnits(de);
    expect(units).toHaveLength(1);
    expect(units[0]!.lessons.map((l) => l.id)).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
    expect(unitOfLesson(de, "de.a1u1.l01")?.unit).toBe(units[0]!.unit);
    expect(unitOfLesson(de, "de.nope.l01")).toBeUndefined();
    expect(unitLabel("A1-1 你好,我是……")).toEqual({ code: "A1-1", theme: "你好,我是……" });
    expect(unitLabel("A1-1")).toEqual({ code: "A1-1", theme: "" });
    expect(checkpointLessonId(de)).toBe("de.a1u1.l02");
  });
});

describe("单元测评出题", () => {
  it("12–15 题,四类题型都有;同一种子出同一套题", () => {
    for (const [ls, code] of [[de, "de"], [fr, "fr"], [en, "en"]] as const) {
      const qs = checkpointQuestions(ls, pool(ls), pack(code), 7);
      expect(qs.length).toBeGreaterThanOrEqual(12);
      expect(qs.length).toBeLessThanOrEqual(15);
      const types = new Set(qs.map((q) => q.type));
      expect(types.has("choose-meaning")).toBe(true);
      expect(types.has("listen-choose")).toBe(true);
      expect(types.has("type-target") || types.has("choose-article")).toBe(true);
      expect(types.has("reorder")).toBe(true);
      expect(qs.some((q) => q.type === "speak")).toBe(false);
      expect(checkpointQuestions(ls, pool(ls), pack(code), 7)).toEqual(qs);
    }
  });

  it("只考这个单元的词;同一个方向不重复考同一个词;选项里有且只有一个正确答案", () => {
    const unitIds = new Set(pool(de).map((i) => i.id));
    for (let seed = 1; seed <= 10; seed++) {
      const qs = checkpointQuestions(de, pool(de), pack("de"), seed);
      for (const ids of Object.values(byDirection(qs))) expect(new Set(ids).size).toBe(ids.length);
      for (const q of qs) {
        if ("itemId" in q) expect(unitIds.has(q.itemId)).toBe(true);
        if ("options" in q) {
          expect(new Set(q.options).size).toBe(q.options.length);
          expect(q.options[q.answer]).toBeDefined();
        }
      }
    }
  });

  it("产出题最多,先易后难:看懂/听懂 → 写出来 → 排序", () => {
    const qs = checkpointQuestions(de, pool(de), pack("de"), 3);
    const kind = (q: Exercise) => (q.type === "reorder" ? 2 : "direction" in q && q.direction === "produce" ? 1 : 0);
    const ks = qs.map(kind);
    expect([...ks].sort()).toEqual(ks);
    const d = byDirection(qs);
    expect(d.produce!.length).toBeGreaterThanOrEqual(d.listen!.length);
    expect(d.produce!.length).toBeGreaterThanOrEqual(d.recognize!.length);
  });

  it("德语名词会考冠词,也会考写全", () => {
    const types = new Set(Array.from({ length: 20 }, (_, s) => checkpointQuestions(de, pool(de), pack("de"), s + 1)).flat().map((q) => q.type));
    expect(types.has("choose-article")).toBe(true);
    expect(types.has("type-target")).toBe(true);
  });

  it("排序题打乱后不会正好是原句的顺序", () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of checkpointQuestions(de, pool(de), pack("de"), seed)) {
        if (q.type === "reorder") expect(checkReorder(q.answer, q.tiles)).toBe(false);
      }
    }
  });

  it("词少的单元多出排序题凑够 12 题;材料太少就少出,不出重复的题", () => {
    // en 只有一课 6 个词:每个词最多考三个方向
    expect(checkpointQuestions(en, pool(en), pack("en"), 1).length).toBeGreaterThanOrEqual(12);
    const tiny = Lesson.parse({ ...de[0]!, newItems: de[0]!.newItems.slice(0, 2), lines: de[0]!.lines.slice(0, 1) });
    const qs = checkpointQuestions([tiny], pool(de), pack("de"), 1);
    expect(qs.length).toBe(7);
    const keys = qs.map((q) => ("itemId" in q ? `${q.direction}:${q.itemId}` : q.type));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("单元练习", () => {
  it("约 25 题,不重复同一个方向的同一个词", () => {
    const qs = unitPracticeQuestions(de, pool(de), pack("de"), 5);
    expect(qs.length).toBe(25);
    for (const ids of Object.values(byDirection(qs))) expect(new Set(ids).size).toBe(ids.length);
    expect(qs.filter((q) => q.type === "reorder").length).toBe(5);
    // 词少的单元也尽量出够 20 题
    expect(unitPracticeQuestions(en, pool(en), pack("en"), 5).length).toBeGreaterThanOrEqual(20);
  });
});

describe("测评打分", () => {
  const qs = checkpointQuestions(de, pool(de), pack("de"), 11);
  const n = qs.length;
  const verdicts = (wrong: number, almost = 0): Verdict[] => qs.map((_, i) => (i < wrong ? "wrong" : i < wrong + almost ? "almost" : "correct"));

  it("80 分及格;基本对算 0.75 分;没答的算错", () => {
    expect(scoreCheckpoint(qs, verdicts(0))).toMatchObject({ score: 100, right: n, total: n, passed: true });
    expect(n).toBe(15);
    // 15 题错 3 题 = 80 分,正好及格(浮点误差不能变成 79)
    expect(scoreCheckpoint(qs, verdicts(3))).toMatchObject({ score: 80, right: 12, passed: true });
    // 错 3 题、另有 1 题基本对:(11 + 0.75) / 15 = 78.3
    expect(scoreCheckpoint(qs, verdicts(3, 1))).toMatchObject({ score: 78, right: 12, passed: false });
    expect(scoreCheckpoint(qs, verdicts(0).slice(0, 10)).score).toBe(66);
    expect(scoreCheckpoint([], []).passed).toBe(false);
  });

  it("列出答错的词和排错的句子", () => {
    const vs = qs.map((q): Verdict => (q.type === "reorder" || q.type === "choose-meaning" ? "wrong" : "correct"));
    const r = scoreCheckpoint(qs, vs);
    const meaningIds = qs.filter((q) => q.type === "choose-meaning").map((q) => ("itemId" in q ? q.itemId : ""));
    expect(r.missedItems).toEqual(meaningIds);
    expect(r.missedLines).toEqual(qs.flatMap((q) => (q.type === "reorder" ? [q.lineText] : [])));
  });
});

describe("单元测评记录", () => {
  it("课都学完才能测;通过后不再提示;记的是最好的成绩", () => {
    let p = completeLesson(withGoal("B1"), de[0]!, at("2026-11-01"));
    expect(unitCheckpoint(p, de).ready).toBe(false);
    expect(pendingCheckpoint(p, de)).toBeUndefined();
    p = completeLesson(p, de[1]!, at("2026-11-01"));
    expect(unitCheckpoint(p, de).ready).toBe(true);
    expect(pendingCheckpoint(p, de)?.unit).toBe(de[0]!.unit);

    p = recordCheckpoint(p, checkpointLessonId(de), 72, at("2026-11-01"));
    expect(unitCheckpoint(p, de)).toMatchObject({ passed: false, attempts: 1, last: { score: 72, day: "2026-11-01" } });
    expect(pendingCheckpoint(p, de)).toBeDefined();
    p = recordCheckpoint(p, checkpointLessonId(de), 92, at("2026-11-02"));
    p = recordCheckpoint(p, checkpointLessonId(de), 85, at("2026-11-03"));
    expect(unitCheckpoint(p, de)).toMatchObject({ passed: true, attempts: 3, best: { score: 92, day: "2026-11-02" }, last: { score: 85, day: "2026-11-03" } });
    expect(pendingCheckpoint(p, de)).toBeUndefined();
  });

  it("单元以后加了课,旧的成绩仍然算这个单元的", () => {
    let p = finishAll(withGoal("B1"), de);
    p = recordCheckpoint(p, checkpointLessonId(de), 90, at("2026-11-02"));
    const added = Lesson.parse({ ...de[1]!, id: "de.a1u1.l03", order: de[1]!.order + 1, newItems: [], reviewItems: [] });
    const grown = [...de, added];
    expect(checkpointLessonId(grown)).toBe("de.a1u1.l03");
    expect(unitCheckpoint(p, grown).passed).toBe(true);
    // 新课没学完:不能再测,但证书还在
    expect(unitCheckpoint(p, grown).ready).toBe(false);
  });

  it("全部是分级测试跳过的单元不提示测评", () => {
    const p: Progress = { ...withGoal("B1"), skipped: de.map((l) => l.id) };
    expect(unitCheckpoint(p, de).ready).toBe(true);
    expect(pendingCheckpoint(p, de)).toBeUndefined();
  });
});

describe("目标达成", () => {
  it("目标等级的课都学完就算达成;目标等级还没有课不算", () => {
    expect(goalReached(withGoal("A1"), de)).toBe(false);
    expect(goalReached(finishAll(withGoal("A1"), de), de)).toBe(true);
    expect(goalReached(finishAll(withGoal("A2"), de), de)).toBe(false);
    expect(goalReached({ ...finishAll(withGoal("A1"), de), goal: null }, de)).toBe(false);
  });

  it("通过了目标等级最后一个单元的测评也算达成(后来又加了课也一样)", () => {
    let p = finishAll(withGoal("A1"), de);
    p = recordCheckpoint(p, checkpointLessonId(de), 88, at("2026-11-02"));
    const added = Lesson.parse({ ...de[1]!, id: "de.a1u1.l03", order: de[1]!.order + 1, newItems: [], reviewItems: [] });
    expect(goalReached(p, [...de, added])).toBe(true);
    // 没通过测评、又有新课没学:还没达成
    expect(goalReached(finishAll(withGoal("A1"), de), [...de, added])).toBe(false);
  });

  it("建议下一个目标:上一个等级或考试方向;保留每天的时长,去掉旧期限", () => {
    const goal = withGoal("A1").goal!;
    const next = nextGoals(goal, pack("de"));
    expect(next[0]!.goal).toEqual({ kind: "study-abroad", target: "A2", dailyMinutes: 15 });
    const exams = next.slice(1);
    expect(exams.length).toBeGreaterThan(0);
    expect(exams.every((n) => n.goal.kind === "exam" && n.goal.target === "A2" && !n.goal.deadline)).toBe(true);
    expect(exams.map((n) => n.goal.exam)).toEqual(pack("de").examsZh.slice(0, 3));
    expect(nextGoals({ ...goal, target: "C1" }, pack("de"))).toEqual([]);
  });
});
