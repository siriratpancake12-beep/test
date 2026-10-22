import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/validate";

const content = join(import.meta.dirname, "..", "..", "..", "content");
const raw = (p: string) => JSON.parse(readFileSync(join(content, p), "utf8"));
const dePack = raw("languages/de.json");
const data = join(import.meta.dirname, "data");
const fixture = (p: string) => JSON.parse(readFileSync(join(data, p), "utf8"));
const l1 = fixture("courses/de/a1u1.l01.json");
const l2 = fixture("courses/de/a1u1.l02.json");

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

describe("只有复数的名词", () => {
  it("德语 die Eltern 标 pl 不报错,不要求复数;用 der 会报", () => {
    const ok = structuredClone(l1);
    ok.newItems.push({ id: "de.eltern", kind: "word", pos: "noun", text: "die Eltern", zh: "父母", features: { gender: "pl" } });
    expect(validateCourse(dePack, [ok, l2]).filter((p) => p.msg.includes("de.eltern"))).toEqual([]);
    const bad = structuredClone(l1);
    bad.newItems.push({ id: "de.eltern", kind: "word", pos: "noun", text: "der Eltern", zh: "父母", features: { gender: "pl" } });
    expect(validateCourse(dePack, [bad, l2]).map((p) => p.msg).join()).toMatch(/复数冠词/);
  });
});
