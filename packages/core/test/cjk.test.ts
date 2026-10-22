import { describe, expect, it } from "vitest";
import { tokens } from "../src/exercises";
import { gradeItem } from "../src/grading";
import { Item, Lesson } from "../src/schema";
import { validateCourse } from "../src/validate";
import { pack } from "./fixtures";

const lesson = (lang: string, over: Record<string, unknown>) => Lesson.parse({
  id: `${lang}.a1u1.l01`, schemaVersion: 1, lang, type: "dialogue", cefr: "A1", unit: "A1-1", order: 101010,
  titleZh: "t", goalZh: "g", canDoZh: "c", skills: ["listen"], estimatedMinutes: 10, newItems: [], ...over,
});

describe("日语", () => {
  const ja = pack("ja");
  it("排序练习用课文写好的分词", () => {
    expect(tokens({ speaker: "a", text: "わたしは学生です。", zh: "我是学生。", items: [], tokens: ["わたし", "は", "学生", "です。"] }, ja)).toEqual(["わたし", "は", "学生", "です。"]);
    expect(tokens({ speaker: "a", text: "わたしは学生です。", zh: "我是学生。", items: [] }, ja)).toBeNull();
  });
  it("有汉字的句子要有读音;分词连起来要等于原句", () => {
    const l = lesson("ja", {
      newItems: [{ id: "ja.gakusei", kind: "word", pos: "noun", text: "学生", zh: "学生", features: { reading: "がくせい" } }],
      lines: [
        { speaker: "narrator", text: "わたしは学生です。", zh: "我是学生。", items: ["ja.gakusei"], tokens: ["わたし", "は", "学生"] },
      ],
    });
    const msgs = validateCourse(ja, [l]).map((p) => p.msg).join("\n");
    expect(msgs).toMatch(/缺少整句读音/);
    expect(msgs).toMatch(/分词 tokens 连起来和原句不一致/);
  });
  it("全角/半角都算对", () => {
    const it2 = Item.parse({ id: "ja.kohi", kind: "word", pos: "noun", text: "コーヒー", zh: "咖啡", features: {} });
    expect(gradeItem("ｺｰﾋｰ", it2, ja).verdict).toBe("correct");
  });
});

describe("韩语", () => {
  const ko = pack("ko");
  it("字母(char)只要求罗马音,不要求词性规则", () => {
    const ok = lesson("ko", { newItems: [{ id: "ko.giyeok", kind: "char", pos: "char", text: "ㄱ", zh: "辅音 g/k", features: { roman: "g/k" } }] });
    expect(validateCourse(ko, [ok])).toEqual([]);
    const bad = lesson("ko", { newItems: [{ id: "ko.nieun", kind: "char", pos: "char", text: "ㄴ", zh: "辅音 n", features: {} }] });
    expect(validateCourse(ko, [bad]).map((p) => p.msg).join()).toMatch(/罗马音/);
  });
});

describe("句子长度", () => {
  it("A1 句子超过上限会报", () => {
    const en = pack("en");
    const long = "I really want to go to the big supermarket near my school with my best friend after class today";
    const l = Lesson.parse({
      id: "en.a1u1.l01", schemaVersion: 1, lang: "en", type: "dialogue", cefr: "A1", unit: "A1-1", order: 101010,
      titleZh: "t", goalZh: "g", canDoZh: "c", skills: ["listen"], estimatedMinutes: 10, newItems: [],
      lines: [{ speaker: "narrator", text: long, zh: "很长的一句", items: [] }],
    });
    expect(validateCourse(en, [l]).map((p) => p.msg).join()).toMatch(/句子太长/);
  });
});
