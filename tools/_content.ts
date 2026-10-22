/**
 * 内容工具共用:读语言包、已写的课、大纲。
 * 大纲可以是一个文件 content/outlines/<lang>.json,也可以分成多个 content/outlines/<lang>/*.json
 * (几个人同时写大纲时各写各的文件),读的时候合并。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Outline, type OutlineLesson } from "../packages/core/src/outline";

export const contentRoot = join(import.meta.dirname, "..", "content");
export const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

export const languageCodes = () => readdirSync(join(contentRoot, "languages")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
export const loadPackRaw = (code: string) => readJson(join(contentRoot, "languages", `${code}.json`));

export function lessonFiles(code: string): string[] {
  const dir = join(contentRoot, "courses", code);
  return existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")).sort().map((x) => join(dir, x)) : [];
}

export function outlineFiles(code: string): string[] {
  const single = join(contentRoot, "outlines", `${code}.json`);
  const dir = join(contentRoot, "outlines", code);
  // plan*.json 是单元规划(只有标题和目标,没有词条),不是大纲
  const many = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith("plan")).sort().map((x) => join(dir, x)) : [];
  return [...(existsSync(single) ? [single] : []), ...many];
}

export interface LoadedOutline {
  lessons: OutlineLesson[];
  errors: string[];
}

export function loadOutline(code: string): LoadedOutline | null {
  const files = outlineFiles(code);
  if (!files.length) return null;
  const errors: string[] = [];
  const lessons: OutlineLesson[] = [];
  for (const f of files) {
    const r = Outline.safeParse(readJson(f));
    if (!r.success) {
      errors.push(`${f.split("/content/")[1]}: ${r.error.issues.slice(0, 8).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      continue;
    }
    lessons.push(...r.data.lessons);
  }
  const seen = new Set<string>();
  for (const l of lessons) {
    if (seen.has(l.id)) errors.push(`大纲里课 id 重复:${l.id}`);
    seen.add(l.id);
  }
  return { lessons, errors };
}
