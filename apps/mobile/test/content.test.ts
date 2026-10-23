import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { orderFromId, type LanguagePack, type Lesson } from "@lingo/core";
import { createLibrary, type LangSummary } from "../src/content/library";

/**
 * 内置课程:生成器(tools/gen-content-index.ts)和 App 的加载(src/content/library.ts)。
 * 用 core 单元测试固定的示例课快照造一份小内容,不跟着正在编写的课程变。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const samples = join(root, "packages", "core", "test", "data", "courses");
const tmp = mkdtempSync(join(tmpdir(), "lingo-content-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const SCENE = {
  id: "de.test_cafe", lang: "de", level: "A1", titleZh: "点咖啡", goalZh: "点一杯咖啡", roleZh: "店员", setupZh: "咖啡馆",
  opening: { text: "Hallo!", zh: "你好!" }, tasks: ["点咖啡"], usefulPhrases: [{ text: "Einen Kaffee, bitte.", zh: "请来一杯咖啡。" }],
};

/** 一份小内容:德语 2 节示例课 + 1 篇读物(文件名排在最前、order 故意写错)+ 1 个场景,法语 2 节,意大利语没有课 */
function makeContent(dir: string) {
  mkdirSync(join(dir, "languages"), { recursive: true });
  for (const c of ["de", "fr", "it"]) cpSync(join(root, "content", "languages", `${c}.json`), join(dir, "languages", `${c}.json`));
  cpSync(join(samples, "de"), join(dir, "courses", "de"), { recursive: true });
  cpSync(join(samples, "fr"), join(dir, "courses", "fr"), { recursive: true });
  const reader = { ...readJson(join(samples, "de", "a1u1.l02.json")), id: "de.a1u1.r01", type: "reading", order: 1 };
  writeFileSync(join(dir, "courses", "de", "0-reader.json"), JSON.stringify(reader));
  mkdirSync(join(dir, "scenarios"), { recursive: true });
  writeFileSync(join(dir, "scenarios", "de.json"), JSON.stringify([SCENE]));
}

const generate = (content: string, out: string) =>
  execFileSync(process.execPath, [tsx, join(root, "tools", "gen-content-index.ts"), "--content", content, "--out", out], { stdio: "pipe" });

/** 生成文件里的 JSON 字符串 */
const dataOf = (out: string, lang: string) =>
  JSON.parse(readFileSync(join(out, `${lang}.generated.ts`), "utf8").match(/export const data: string = (".*");\n/)![1]!) as string;

const content = join(tmp, "content");
const out = join(tmp, "out");
makeContent(content);
generate(content, out);

describe("生成器", () => {
  it("构建时校验、填好默认值,课按 id 推出的顺序排(order 也改成这个值)", () => {
    const de = JSON.parse(dataOf(out, "de")) as { lessons: Lesson[]; scenarios: { id: string; review: string }[] };
    expect(de.lessons.map((l) => l.id)).toEqual(["de.a1u1.l01", "de.a1u1.l02", "de.a1u1.r01"]);
    expect(de.lessons.map((l) => l.order)).toEqual(["de.a1u1.l01", "de.a1u1.l02", "de.a1u1.r01"].map(orderFromId));
    // 默认值是 zod 填的,App 不用再解析
    expect(de.lessons.every((l) => Array.isArray(l.reviewItems) && l.lines.every((x) => Array.isArray(x.items)) && l.review)).toBe(true);
    expect(de.scenarios).toMatchObject([{ id: "de.test_cafe", review: "draft" }]);
  });

  it("索引里有全部语言包和摘要;没课也没场景的语种不生成文件", () => {
    const index = readFileSync(join(out, "index.generated.ts"), "utf8");
    expect(index).toContain('de: {"lessons":3,"units":1,"levels":["A1"],"scenarios":1}');
    expect(index).toContain('it: {"lessons":0,"units":0,"levels":[],"scenarios":0}');
    // 懒加载:require 写在函数里
    expect(index).toContain('de: () => (require("./de.generated") as LangModule).data');
    expect(index).not.toContain('"./it.generated"');
    expect(existsSync(join(out, "it.generated.ts"))).toBe(false);
  });

  it("内容格式不对:全部列出来、退出码 1,不改已经生成的文件", () => {
    const bad = join(tmp, "bad");
    makeContent(bad);
    const l = readJson(join(bad, "courses", "de", "a1u1.l01.json"));
    delete l.canDoZh;
    writeFileSync(join(bad, "courses", "de", "a1u1.l01.json"), JSON.stringify(l));
    writeFileSync(join(bad, "courses", "fr", "a1u1.l02.json"), "{ 坏了");
    writeFileSync(join(bad, "courses", "fr", "x.json"), JSON.stringify({ ...readJson(join(samples, "de", "a1u1.l01.json")) }));
    const before = readFileSync(join(out, "de.generated.ts"), "utf8");
    let err: { status?: number; stderr?: Buffer } = {};
    try {
      generate(bad, out);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(1);
    const msg = err.stderr?.toString() ?? "";
    expect(msg).toContain("courses/de/a1u1.l01.json: canDoZh");
    expect(msg).toContain("courses/fr/a1u1.l02.json: 不是合法的 JSON");
    expect(msg).toContain("不属于 fr");
    expect(readFileSync(join(out, "de.generated.ts"), "utf8")).toBe(before);
  });
});

describe("App 加载内置课程", () => {
  const packs = ["de", "fr", "it"].map((c) => readJson(join(content, "languages", `${c}.json`)) as LanguagePack);
  const summaries: Record<string, LangSummary> = {
    de: { lessons: 3, units: 1, levels: ["A1"], scenarios: 1 },
    fr: { lessons: 2, units: 1, levels: ["A1"], scenarios: 0 },
    it: { lessons: 0, units: 0, levels: [], scenarios: 0 },
  };
  const make = (data: Record<string, string>, validate = false) => {
    const calls: string[] = [];
    const loaders = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, () => (calls.push(k), v)]));
    return { lib: createLibrary({ packs, summaries, loaders }, { validate }), calls };
  };

  it("选语种只看摘要,不加载课;第一次用到某个语种才解析,之后用缓存", () => {
    const { lib, calls } = make({ de: dataOf(out, "de"), fr: dataOf(out, "fr") });
    expect(lib.availableLangs().map((p) => p.code)).toEqual(["de", "fr"]);
    expect(lib.comingSoonLangs().map((p) => p.code)).toEqual(["it"]);
    expect(calls).toEqual([]);
    expect(lib.getLesson("de.a1u1.l02")?.id).toBe("de.a1u1.l02");
    expect(lib.getLessons("de").map((l) => l.id)).toEqual(["de.a1u1.l01", "de.a1u1.l02", "de.a1u1.r01"]);
    expect(lib.itemPool("de")).toBe(lib.itemPool("de"));
    expect(lib.getScenario("de.test_cafe")?.titleZh).toBe("点咖啡");
    expect(calls).toEqual(["de"]);
    // 没有课的语种、不认识的语种:返回空的,不进缓存
    expect(lib.getLessons("it")).toEqual([]);
    expect(lib.getLesson("xx.a1u1.l01")).toBeUndefined();
    expect(lib.loadedLangs()).toEqual(["de"]);
  });

  it("开发版对一遍 schema:对不上只提示,照样能用;生成的文件坏了不让 App 崩", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const de = JSON.parse(dataOf(out, "de"));
    delete de.lessons[0].canDoZh;
    const { lib } = make({ de: JSON.stringify(de), fr: "{ 坏了" }, true);
    expect(lib.getLessons("de")).toHaveLength(3);
    expect(warn.mock.calls[0]?.[0]).toContain("npm run content:index");
    expect(lib.getLessons("fr")).toEqual([]);
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
