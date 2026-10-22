import { describe, expect, it } from "vitest";
import { courseHours, estimateLessonMinutes, orderFromId } from "../src/hours";
import { Lesson } from "../src/schema";
import { lessons } from "./fixtures";

describe("课程顺序", () => {
  it("按等级、单元、课号排;读物插在课之间", () => {
    const ids = ["de.a2u1.l01", "de.a1u2.l01", "de.a1u1.r02", "de.a1u1.l08", "de.a1u1.r01", "de.a1u1.l05", "de.a1u1.l04", "de.a1u1.l01"];
    const sorted = [...ids].sort((a, b) => orderFromId(a)! - orderFromId(b)!);
    expect(sorted).toEqual(["de.a1u1.l01", "de.a1u1.l04", "de.a1u1.r01", "de.a1u1.l05", "de.a1u1.l08", "de.a1u1.r02", "de.a1u2.l01", "de.a2u1.l01"]);
    // A2 每单元三篇读物:第 3、6、8 课后
    expect(orderFromId("de.a2u1.r01")).toBe(orderFromId("de.a2u1.l03")! + 5);
    expect(orderFromId("de.a2u1.r02")).toBe(orderFromId("de.a2u1.l06")! + 5);
    expect(orderFromId("de.a2u1.r03")).toBe(orderFromId("de.a2u1.l08")! + 5);
    expect(orderFromId("de.a1u12.l03")).toBe(112030);
    expect(orderFromId("de.foo")).toBeNull();
  });
});

describe("学习时长", () => {
  const de = lessons("de");
  it("按课的内容算", () => {
    const l = de[0]!;
    // 5 句对话、6 个生词、1 个语法(2 个例句)、2 道理解题
    expect(estimateLessonMinutes(l)).toBeGreaterThan(10);
    const noRoleplay = Lesson.parse({ ...l, type: "vocab" });
    expect(estimateLessonMinutes(noRoleplay)).toBeLessThan(estimateLessonMinutes(l));
  });
  it("整门课:课 + 复习 + 每单元的练习和测评", () => {
    const h = courseHours(de);
    expect(h.units).toBe(1);
    expect(h.lessons).toBe(2);
    const raw = de.reduce((a, l) => a + estimateLessonMinutes(l), 0);
    expect(h.totalHours).toBeCloseTo((raw * 1.15 + 22) / 60, 1);
  });
});
