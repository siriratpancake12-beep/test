/**
 * 把核心大纲里每单元的复习课从第 6 课挪到第 8 课:`npx tsx tools/move-review-lesson.ts --lang en`
 * (A1 核心大纲是 8 单元 × 6 课,扩成每单元 8 课时,新加的第 6、7 课放在复习课前面。)
 * 只改大纲文件里的 id(和对它的引用);课文件只有已存在的 l06 才需要改名,目前都还没写。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentRoot } from "./_content";

const i = process.argv.indexOf("--lang");
const lang = i >= 0 ? process.argv[i + 1] : undefined;
if (!lang) throw new Error("用法:--lang en");
const path = join(contentRoot, "outlines", `${lang}.json`);
let text = readFileSync(path, "utf8");
let n = 0;
text = text.replace(new RegExp(`"(${lang}\\.a1u[1-8])\\.l06"`, "g"), (_m, unit: string) => {
  n++;
  return `"${unit}.l08"`;
});
JSON.parse(text);
writeFileSync(path, text);
for (let u = 1; u <= 8; u++) {
  const from = join(contentRoot, "courses", lang, `a1u${u}.l06.json`);
  if (existsSync(from)) {
    renameSync(from, join(contentRoot, "courses", lang, `a1u${u}.l08.json`));
    console.log(`课文件改名:a1u${u}.l06 → l08(记得改文件里的 id)`);
  }
}
console.log(`改了 ${n} 处 id`);
