import { describe, expect, it } from "vitest";
import { gradeItem, gradeText, levenshtein, splitArticle } from "../src/grading";
import { Item } from "../src/schema";
import { pack } from "./fixtures";

const de = pack("de"), fr = pack("fr"), en = pack("en"), ja = pack("ja");
const item = (o: Partial<Item> & { text: string }) => Item.parse({ id: "xx.t", kind: "word", pos: "noun", zh: "x", ...o });

describe("德语", () => {
  it("冠词错了判错,并指出正确冠词", () => {
    const r = gradeText("die Vater", "der Vater", de);
    expect(r.verdict).toBe("wrong");
    expect(r.issues).toEqual([{ kind: "article", expected: "der", got: "die" }]);
  });
  it("名词小写算基本对,提示大写", () => {
    expect(gradeText("der vater", "der Vater", de)).toMatchObject({ verdict: "almost", issues: [{ kind: "case" }] });
  });
  it("ae/oe/ue/ss 替代写法算基本对", () => {
    expect(gradeText("Tschuess", "Tschüss", de)).toMatchObject({ verdict: "almost", issues: [{ kind: "umlaut-fallback" }] });
    expect(gradeText("Ich heisse", "Ich heiße", de).verdict).toBe("almost");
  });
  it("Hund / Hand 这种短词不当笔误放过", () => {
    expect(gradeText("die Hand", "der Hund", de).verdict).toBe("wrong");
    expect(gradeText("Hand", "Hund", de).verdict).toBe("wrong");
  });
  it("长词一个字母笔误算基本对", () => {
    expect(gradeText("die Schwster", "die Schwester", de)).toMatchObject({ verdict: "almost", issues: [{ kind: "typo" }] });
  });
});

describe("法语", () => {
  it("漏了重音符号算基本对", () => {
    expect(gradeText("le the", "le thé", fr)).toMatchObject({ verdict: "almost", issues: [{ kind: "accent" }] });
  });
  it("le/la 搞错判错", () => {
    expect(gradeText("la café", "le café", fr).issues[0]).toMatchObject({ kind: "article", expected: "le" });
  });
  it("l' 冠词能拆开,弯引号也认", () => {
    expect(splitArticle("l'eau", fr)).toEqual(["l'", "eau"]);
    expect(gradeText("l’eau", "l'eau", fr).verdict).toBe("correct");
  });
  it("大小写和标点不计较", () => {
    expect(gradeText("bonjour!", "Bonjour", fr).verdict).toBe("correct");
  });
});

describe("其他", () => {
  it("英语接受变体写法", () => {
    expect(gradeItem("Thanks", item({ text: "Thank you", alt: ["Thanks"] }), en).verdict).toBe("correct");
  });
  it("日语用假名写出汉字词算基本对;浊音点不能被当成重音符号去掉", () => {
    const w = item({ text: "学校", features: { reading: "がっこう" } });
    expect(gradeItem("がっこう", w, ja)).toMatchObject({ verdict: "almost", issues: [{ kind: "reading" }] });
    expect(gradeText("かっこう", "がっこう", ja).verdict).toBe("wrong");
  });
  it("编辑距离", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});
