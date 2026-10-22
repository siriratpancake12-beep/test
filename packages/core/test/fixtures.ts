import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LanguagePack, Lesson } from "../src/schema";

const root = join(import.meta.dirname, "..", "..", "..", "content");
/** 单元测试用的课固定在 test/data 里(几节示例课的快照),不跟着正在编写的课程变;真实课程由 npm run validate 检查。 */
const data = join(import.meta.dirname, "data");
export const pack = (code: string) => LanguagePack.parse(JSON.parse(readFileSync(join(root, "languages", `${code}.json`), "utf8")));
export const lessons = (code: string) =>
  readdirSync(join(data, "courses", code)).sort().map((f) => Lesson.parse(JSON.parse(readFileSync(join(data, "courses", code, f), "utf8"))));
