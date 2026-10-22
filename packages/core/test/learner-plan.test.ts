import { describe, expect, it } from "vitest";
import { weaknessDrill } from "../src/exercises";
import { activeVocab, engagement, pace, topWeakness, usualHour } from "../src/learner";
import { dailyPlan, reviewCap } from "../src/plan";
import { completeLesson, emptyProgress, finishReview, recordAnswer, type Progress } from "../src/session";
import { lessons, pack } from "./fixtures";

const de = lessons("de");
const dePool = de.flatMap((l) => l.newItems);
const at = (day: string, h = 20) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00+08:00`);
const articleMistake = { kind: "article", expected: "der", got: "die" } as const;
const opts = { premium: true, canAccess: () => true };

function answers(p: Progress, now: Date, n: number, verdict: "correct" | "wrong") {
  for (let i = 0; i < n; i++) p = recordAnswer(p, { itemId: dePool[i % dePool.length]!.id, direction: "recognize", verdict }, now);
  return p;
}

describe("学习者画像", () => {
  it("弱点:反复犯同一种错才算,两周不犯自然消失", () => {
    let p = emptyProgress("de");
    p = recordAnswer(p, { itemId: "de.vater", direction: "produce", verdict: "wrong", issues: [articleMistake] }, at("2026-11-01"));
    expect(topWeakness(p, at("2026-11-01"))).toBeUndefined();
    p = recordAnswer(p, { itemId: "de.mutter", direction: "produce", verdict: "wrong", issues: [articleMistake] }, at("2026-11-01"));
    p = recordAnswer(p, { itemId: "de.kind", direction: "produce", verdict: "wrong", issues: [articleMistake] }, at("2026-11-01"));
    expect(topWeakness(p, at("2026-11-02"))?.kind).toBe("article");
    expect(topWeakness(p, at("2026-11-15"))).toBeUndefined();
  });

  it("难度调节:正确率太高加快,太低放慢,样本少不调", () => {
    expect(pace(answers(emptyProgress("de"), at("2026-11-01"), 10, "wrong"))).toBe("steady");
    expect(pace(answers(emptyProgress("de"), at("2026-11-01"), 40, "correct"))).toBe("faster");
    let p = answers(emptyProgress("de"), at("2026-11-01"), 20, "correct");
    p = answers(p, at("2026-11-01"), 20, "wrong");
    expect(pace(p)).toBe("slower");
  });

  it("能主动用的词只算产出方向记得牢的", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
    expect(activeVocab(p, at("2026-11-01"))).toBe(0);
    // 刚答过(哪怕答错)记忆概率都接近 100%,但还没记牢,不算
    p = recordAnswer(p, { itemId: "de.tschuess", direction: "produce", verdict: "wrong" }, at("2026-11-01"));
    expect(activeVocab(p, at("2026-11-01", 21))).toBe(0);
    // 很快就答对(→ 直接进入长期复习)才算
    p = recordAnswer(p, { itemId: "de.hallo", direction: "produce", verdict: "correct", ms: 1000 }, at("2026-11-01"));
    p = recordAnswer(p, { itemId: "de.hallo", direction: "recognize", verdict: "correct", ms: 1000 }, at("2026-11-01"));
    expect(activeVocab(p, at("2026-11-01", 21))).toBe(1);
  });

  it("流失风险:几天没来、或这周比上周少很多", () => {
    let p = emptyProgress("de");
    for (const d of ["2026-11-01", "2026-11-02", "2026-11-03"]) p = recordAnswer(answers(p, at(d), 5, "correct"), { verdict: "correct", skill: "speak", ms: 0 }, at(d));
    expect(engagement(p, at("2026-11-03")).risk).toBe("low");
    expect(engagement(p, at("2026-11-05")).daysAway).toBe(2);
    expect(engagement(p, at("2026-11-05")).risk).toBe("medium");
    expect(engagement(p, at("2026-11-09")).risk).toBe("high");
  });

  it("提醒时间跟着学习习惯走", () => {
    expect(usualHour(emptyProgress("de"))).toBe(20);
    const p = answers(emptyProgress("de"), at("2026-11-01", 7), 3, "correct");
    expect(usualHour(p)).toBe(7);
  });
});

describe("每日计划", () => {
  it("新用户:只有第一课", () => {
    const plan = dailyPlan(emptyProgress("de"), de, at("2026-11-01"), opts);
    expect(plan.blocks).toEqual([{ kind: "lesson", lessonId: "de.a1u1.l01", minutes: 8, done: false, locked: false }]);
  });

  it("有到期复习先复习;有弱点加专练(非会员显示锁)", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
    p = completeLesson(p, de[1]!, at("2026-11-01"));
    for (const id of ["de.vater", "de.mutter", "de.kind"]) p = recordAnswer(p, { itemId: id, direction: "produce", verdict: "wrong", issues: [articleMistake] }, at("2026-11-01"));
    const plan = dailyPlan(p, de, at("2026-11-02"), { premium: false, canAccess: () => true });
    expect(plan.blocks.map((b) => b.kind)).toEqual(["review", "drill"]);
    expect(plan.blocks[1]).toMatchObject({ weakness: "article", locked: true });
    expect(plan.notes.map((n) => n.code)).toContain("course-finished");
  });

  it("离开 3 天以上:回归模式,只安排复习,不学新课", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
    p = answers(p, at("2026-11-01"), 5, "correct");
    const plan = dailyPlan(p, de, at("2026-11-06"), opts);
    expect(plan.mode).toBe("comeback");
    expect(plan.blocks.map((b) => b.kind)).toEqual(["review"]);
    expect(plan.notes[0]?.zh).toMatch(/欢迎回来/);
    expect(reviewCap(p, at("2026-11-06"))).toBeGreaterThan(reviewCap(p, at("2026-11-02")));
  });

  it("做完复习打勾;今天学完的课也打勾", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
    p = finishReview(p, at("2026-11-01"));
    const plan = dailyPlan(p, de, at("2026-11-01", 21), opts);
    expect(plan.blocks.find((b) => b.kind === "review")?.done).toBe(true);
    expect(plan.blocks.find((b) => b.kind === "lesson")).toMatchObject({ lessonId: "de.a1u1.l01", done: true });
  });

  it("没有会员的课在计划里显示锁", () => {
    const plan = dailyPlan(emptyProgress("de"), de, at("2026-11-01"), { premium: false, canAccess: () => false });
    expect(plan.blocks[0]).toMatchObject({ kind: "lesson", locked: true });
  });
});

describe("弱点专练", () => {
  it("冠词弱点 → 只出选冠词题,记得最差的在前", () => {
    let p = completeLesson(emptyProgress("de"), de[1]!, at("2026-11-01"));
    p = recordAnswer(p, { itemId: "de.vater", direction: "produce", verdict: "correct" }, at("2026-11-01"));
    const drill = weaknessDrill("article", p, dePool, pack("de"), at("2026-11-02"));
    expect(drill.length).toBe(5);
    expect(drill.every((e) => e.type === "choose-article")).toBe(true);
    expect(drill.at(-1)).toMatchObject({ itemId: "de.vater" });
  });

  it("相关的词太少就不出", () => {
    const p = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
    expect(weaknessDrill("article", p, dePool, pack("de"), at("2026-11-02"))).toEqual([]);
  });
});
