import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/validate";

const content = join(import.meta.dirname, "..", "..", "..", "content");
const raw = (p: string) => JSON.parse(readFileSync(join(content, p), "utf8"));
const dePack = raw("languages/de.json");
const l1 = raw("courses/de/a1u1.l01.json");
const l2 = raw("courses/de/a1u1.l02.json");

describe("内容检查", () => {
  it("示例课程没有问题", () => {
    expect(validateCourse(dePack, [l1, l2])).toEqual([]);
  });
  it("冠词和性别不一致、缺复数、名词小写都会报", () => {
    const bad = structuredClone(l2);
    bad.newItems[0] = { ...bad.newItems[0], text: "die vater", features: { gender: "m" } };
    const msgs = validateCourse(dePack, [l1, bad]).map((p) => p.msg).join("\n");
    expect(msgs).toMatch(/冠词 die 和性别 m 不一致/);
    expect(msgs).toMatch(/缺少复数/);
    expect(msgs).toMatch(/首字母要大写/);
  });
  it("课文用了没教过的词会报", () => {
    const msgs = validateCourse(dePack, [l2]).map((p) => p.msg);
    expect(msgs.some((m) => m.includes("de.hallo"))).toBe(true);
  });
});
