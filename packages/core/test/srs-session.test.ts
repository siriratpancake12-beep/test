import { describe, expect, it } from "vitest";
import { completeLesson, emptyProgress, isUnlocked, nextLesson, recordAnswer, streak, todaysReview } from "../src/session";
import { cardKey, isMastered } from "../src/srs";
import { lessons } from "./fixtures";

const de = lessons("de");
const t0 = new Date("2026-11-01T08:00:00Z");
const days = (n: number) => new Date(t0.getTime() + n * 86400_000);

describe("学习进度", () => {
  it("按顺序解锁", () => {
    const p = emptyProgress("de");
    expect(nextLesson(de, p)?.id).toBe("de.a1u1.l01");
    expect(isUnlocked(de, p, "de.a1u1.l02")).toBe(false);
    const p2 = completeLesson(p, de[0]!, t0);
    expect(isUnlocked(de, p2, "de.a1u1.l02")).toBe(true);
    expect(nextLesson(de, p2)?.id).toBe("de.a1u1.l02");
  });

  it("学完一课每个词建三张卡,重复学不会重复建", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, t0);
    p = completeLesson(p, de[0]!, t0);
    expect(Object.keys(p.cards)).toHaveLength(de[0]!.newItems.length * 3);
    expect(p.completedLessons).toEqual(["de.a1u1.l01"]);
  });

  it("答对的卡间隔变长,答错的很快再出现", () => {
    let p = completeLesson(emptyProgress("de"), de[0]!, t0);
    p = recordAnswer(p, "de.hallo", "produce", "correct", t0);
    p = recordAnswer(p, "de.tschuess", "produce", "wrong", t0);
    const right = p.cards[cardKey("de.hallo", "produce")]!.card.due;
    const wrong = p.cards[cardKey("de.tschuess", "produce")]!.card.due;
    expect(right.getTime()).toBeGreaterThan(wrong.getTime());
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
      for (const d of ["recognize", "listen", "produce"] as const) p = recordAnswer(p, "de.hallo", d, "correct", t);
      t = new Date(p.cards[cardKey("de.hallo", "produce")]!.card.due);
    }
    expect(isMastered(Object.values(p.cards), "de.hallo")).toBe(true);
  });

  it("连续天数", () => {
    let p = emptyProgress("de");
    for (const d of [0, 1, 2, 4, 5]) p = recordAnswer(p, "de.hallo", "recognize", "correct", days(d));
    expect(streak(p, days(5))).toBe(2);
    expect(streak(p, days(6))).toBe(2);
    expect(streak(p, days(7))).toBe(0);
  });
});
