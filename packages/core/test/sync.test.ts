import { describe, expect, it } from "vitest";
import { completeLesson, emptyProgress, recordAnswer, type Progress } from "../src/session";
import { mergeProgress } from "../src/sync";
import { cardKey } from "../src/srs";
import { lessons } from "./fixtures";

const de = lessons("de");
const at = (day: string, h = 20) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00+08:00`);
/** 模拟存到服务器再取回来:日期变成字符串 */
const viaJson = (p: Progress): Progress => JSON.parse(JSON.stringify(p));

describe("多设备进度合并", () => {
  // 手机学了第一课,平板学了第二课
  let phone = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
  phone = recordAnswer(phone, { itemId: "de.hallo", direction: "produce", verdict: "correct" }, at("2026-11-02"));
  let tablet = completeLesson(emptyProgress("de"), de[1]!, at("2026-11-03"));
  tablet = { ...tablet, goal: { kind: "travel", target: "A2", dailyMinutes: 20 } };

  it("学过的课、词、复习卡都保留", () => {
    const m = mergeProgress(phone, tablet);
    expect(Object.keys(m.completed).sort()).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
    expect(Object.keys(m.learned)).toHaveLength(12);
    expect(m.cards[cardKey("de.hallo", "produce")]!.card.reps).toBe(1);
    expect(m.cards[cardKey("de.vater", "produce")]).toBeDefined();
  });

  it("设置取最近学习的那台设备", () => {
    expect(mergeProgress(phone, tablet).goal?.target).toBe("A2");
  });

  it("和顺序无关,重复合并不变;经过 JSON(日期变字符串)也一样", () => {
    const ab = mergeProgress(phone, tablet);
    const ba = mergeProgress(tablet, phone);
    expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
    expect(JSON.stringify(mergeProgress(ab, tablet))).toBe(JSON.stringify(ab));
    expect(JSON.stringify(mergeProgress(viaJson(phone), viaJson(tablet)))).toBe(JSON.stringify(viaJson(ab)));
  });

  it("同一天两台设备的日志取较大值,不重复计算", () => {
    const p1 = recordAnswer(emptyProgress("de"), { verdict: "correct", skill: "speak", ms: 30_000 }, at("2026-11-05"));
    const m = mergeProgress(p1, p1);
    expect(m.log["2026-11-05"]!.answers).toBe(1);
    expect(m.log["2026-11-05"]!.seconds).toBe(30);
  });

  it("不同语种不能合并", () => {
    expect(() => mergeProgress(emptyProgress("de"), emptyProgress("fr"))).toThrow();
  });
});
