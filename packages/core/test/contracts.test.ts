import { describe, expect, it } from "vitest";
import { AppEvent, EventsReq, Outline, ROUTES, SmsVerifyReq, stubLesson, TutorChatReq } from "../src/index";
import { pack } from "./fixtures";
import { validateCourse } from "../src/validate";

describe("接口约定", () => {
  it("手机号和验证码格式", () => {
    expect(SmsVerifyReq.safeParse({ phone: "13800138000", code: "123456" }).success).toBe(true);
    expect(SmsVerifyReq.safeParse({ phone: "12800138000", code: "123456" }).success).toBe(false);
    expect(SmsVerifyReq.safeParse({ phone: "13800138000", code: "12345" }).success).toBe(false);
  });
  it("埋点:不接受超长的属性值,一批最多 200 条", () => {
    const ev = { id: "e_12345678", name: "lesson_complete", at: "2026-11-01T12:00:00.000Z", anonId: "anon_12345678", props: { lessonId: "de.a1u1.l01", correct: 5 }, platform: "ios", appVersion: "1.0.0" };
    expect(AppEvent.safeParse(ev).success).toBe(true);
    expect(AppEvent.safeParse({ ...ev, props: { text: "x".repeat(201) } }).success).toBe(false);
    expect(EventsReq.safeParse({ events: Array(201).fill(ev) }).success).toBe(false);
  });
  it("AI 老师请求要带学过的词和等级", () => {
    expect(TutorChatReq.safeParse({ lang: "de", scenarioId: "cafe", level: "A1", knownWords: ["Kaffee"], messages: [{ role: "user", text: "Hallo" }] }).success).toBe(true);
  });
  it("进度路径带语种", () => {
    expect(ROUTES.progress("fr")).toBe("/v1/progress/fr");
  });
});

describe("课程大纲", () => {
  it("大纲里的课可以当作占位课参与校验", () => {
    const outline = Outline.parse({
      lang: "de", levels: ["A1"], units: [{ unit: "A1-1", cefr: "A1", themeZh: "问候" }],
      lessons: [{
        id: "de.a1u1.l09", lang: "de", type: "vocab", cefr: "A1", unit: "A1-1", order: 9, titleZh: "数字", goalZh: "会数数",
        canDoZh: "能说 1–10", skills: ["listen"], estimatedMinutes: 8, scenarioZh: "在超市",
        newItems: [{ id: "de.eins", kind: "word", pos: "num", text: "eins", zh: "一", features: {} }], reviewItems: [],
      }],
    });
    const stub = stubLesson(outline.lessons[0]!);
    expect(stub.lines).toEqual([]);
    expect(validateCourse(pack("de"), [stub])).toEqual([]);
  });
});
