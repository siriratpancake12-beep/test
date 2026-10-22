import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LanguagePack, Lesson } from "../src/schema";

const root = join(import.meta.dirname, "..", "..", "..", "content");
export const pack = (code: string) => LanguagePack.parse(JSON.parse(readFileSync(join(root, "languages", `${code}.json`), "utf8")));
export const lessons = (code: string) =>
  readdirSync(join(root, "courses", code)).sort().map((f) => Lesson.parse(JSON.parse(readFileSync(join(root, "courses", code, f), "utf8"))));
