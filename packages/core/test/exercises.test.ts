import { describe, expect, it } from "vitest";
import { checkReorder, exerciseFor, lessonPractice } from "../src/exercises";
import { lessons, pack } from "./fixtures";

const de = lessons("de"), fr = lessons("fr");
const dePool = de.flatMap((l) => l.newItems);

describe("练习生成", () => {
  it("同样的种子出同样的题,选项里有且只有一个正确答案", () => {
    const a = lessonPractice(de[1]!, dePool, pack("de"), 7);
    expect(lessonPractice(de[1]!, dePool, pack("de"), 7)).toEqual(a);
    for (const e of a) if ("options" in e) {
      expect(new Set(e.options).size).toBe(e.options.length);
      expect(e.answer).toBeGreaterThanOrEqual(0);
    }
  });

  it("德语名词会出选冠词题,正确答案是本词的冠词", () => {
    const vater = dePool.find((i) => i.id === "de.vater")!;
    const ex = Array.from({ length: 20 }, (_, s) => exerciseFor(vater, "produce", dePool, pack("de"), s)).find((e) => e.type === "choose-article");
    expect(ex).toBeDefined();
    if (ex?.type === "choose-article") {
      expect(ex.noun).toBe("Vater");
      expect(ex.options[ex.answer]).toBe("der");
      expect(ex.options).toEqual(expect.arrayContaining(["der", "die", "das"]));
    }
  });

  it("冠词选项顺序固定,正确答案不总在第一个", () => {
    const mutter = dePool.find((i) => i.id === "de.mutter")!;
    const kind = dePool.find((i) => i.id === "de.kind")!;
    const a = exerciseFor(mutter, "produce", dePool, pack("de"), 1, "article");
    const b = exerciseFor(kind, "produce", dePool, pack("de"), 1, "article");
    expect(a).toMatchObject({ options: ["der", "die", "das"], answer: 1 });
    expect(b).toMatchObject({ options: ["der", "die", "das"], answer: 2 });
  });

  it("法语选冠词题不出 l' 和 les", () => {
    const pool = fr.flatMap((l) => l.newItems);
    const cafe = pool.find((i) => i.id === "fr.cafe")!;
    for (let s = 0; s < 20; s++) {
      const e = exerciseFor(cafe, "produce", pool, pack("fr"), s);
      if (e.type === "choose-article") expect(e.options.sort()).toEqual(["la", "le"]);
    }
  });

  it("排序题和开口说", () => {
    const ex = lessonPractice(de[0]!, dePool, pack("de"), 3);
    const r = ex.find((e) => e.type === "reorder");
    expect(r && r.type === "reorder" && checkReorder(r.answer, r.answer)).toBe(true);
    expect(ex.some((e) => e.type === "speak")).toBe(true);
  });
});
