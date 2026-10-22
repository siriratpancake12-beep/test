import { describe, expect, it } from "vitest";
import { completeLesson, emptyProgress, isUnlocked, nextLesson, normalizeProgress, recordAnswer, todaysReview } from "../src/session";
import { cardKey, isMastered } from "../src/srs";
import { dayKey } from "../src/time";
import { lessons } from "./fixtures";

const de = lessons("de");
const t0 = new Date("2026-11-01T08:00:00Z");

describe("学习进度", () => {
  it("按顺序解锁", () => {
    const p = emptyProgress("de");
    expect(nextLesson(de, p)?.id).toBe("de.a1u1.l01");
    expect(isUnlocked(de, p, "de.a1u1.l02")).toBe(false);
    const p2 = completeLesson(p, de[0]!, t0);
    expect(isUnlocked(de, p2, "de.a1u1.l02")).toBe(true);
    expect(nextLesson(de, p2)?.id).toBe("de.a1u1.l02");
  });

  it("学完一课每个词建三张卡,重复学不会重复建,也不重复计新词", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, t0);
    p = completeLesson(p, de[0]!, t0);
    expect(Object.keys(p.cards)).toHaveLength(de[0]!.newItems.length * 3);
    expect(Object.keys(p.completed)).toEqual(["de.a1u1.l01"]);
    expect(p.log[dayKey(t0)]!.newItems).toBe(de[0]!.newItems.length);
  });

  it("课里的练习先建了卡,学完时这些词仍算新学的", () => {
    let p = emptyProgress("de");
    for (const it of de[0]!.newItems) p = recordAnswer(p, { itemId: it.id, direction: "recognize", verdict: "correct" }, t0);
    p = completeLesson(p, de[0]!, t0);
    expect(p.log[dayKey(t0)]!.newItems).toBe(de[0]!.newItems.length);
    expect(Object.keys(p.learned)).toHaveLength(de[0]!.newItems.length);
  });

  it("答对的卡间隔变长,答错的很快再出现", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, t0);
    p = recordAnswer(p, { itemId: "de.hallo", direction: "produce", verdict: "correct" }, t0);
    p = recordAnswer(p, { itemId: "de.tschuess", direction: "produce", verdict: "wrong" }, t0);
    const right = p.cards[cardKey("de.hallo", "produce")]!.card.due;
    const wrong = p.cards[cardKey("de.tschuess", "produce")]!.card.due;
    expect(right.getTime()).toBeGreaterThan(wrong.getTime());
  });

  it("答题记进当天日志:时长封顶、得分、技能、错误类型", () => {
    let p = emptyProgress("de");
    p = recordAnswer(p, { itemId: "de.vater", direction: "produce", verdict: "wrong", ms: 300_000, issues: [{ kind: "article", expected: "der", got: "die" }] }, t0);
    p = recordAnswer(p, { itemId: "de.vater", direction: "recognize", verdict: "almost", ms: 4000 }, t0);
    const d = p.log[dayKey(t0)]!;
    expect(d.seconds).toBe(64); // 第一道 300 秒按 60 秒算
    expect(d.answers).toBe(2);
    expect(d.score).toBe(0.75);
    expect(d.issues.article).toBe(1);
    expect(p.recent.write).toEqual([0]);
    expect(p.recent.read).toEqual([0.75]);
    expect(p.issues.article?.weight).toBe(1);
  });

  it("今天的复习有上限", () => {
    let p = emptyProgress("de");
    for (const l of de) p = completeLesson(p, l, t0);
    expect(todaysReview(p, t0, 5, 5)).toHaveLength(5);
  });

  it("长期答对 → 掌握", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, t0);
    let t = t0;
    for (let i = 0; i < 6; i++) {
      for (const d of ["recognize", "listen", "produce"] as const) p = recordAnswer(p, { itemId: "de.hallo", direction: d, verdict: "correct" }, t);
      t = new Date(p.cards[cardKey("de.hallo", "produce")]!.card.due);
    }
    expect(isMastered(Object.values(p.cards), "de.hallo")).toBe(true);
  });

  it("按当地日期记日:北京时间早上 7 点算当天,不算前一天", () => {
    const morning = new Date("2026-11-02T07:00:00+08:00");
    const p = recordAnswer(emptyProgress("de"), { verdict: "correct", skill: "speak" }, morning);
    expect(Object.keys(p.log)).toEqual(["2026-11-02"]);
  });

  it("读第一版存档", () => {
    const p = normalizeProgress({ lang: "de", completedLessons: ["de.a1u1.l01"], activeDays: ["2026-10-30", "2026-10-31"], cards: {} });
    expect(p.completed).toEqual({ "de.a1u1.l01": "2026-10-31" });
    expect(Object.keys(p.log)).toEqual(["2026-10-30", "2026-10-31"]);
    expect(p.version).toBe(2);
    expect(p.recent.speak).toEqual([]);
  });
});
