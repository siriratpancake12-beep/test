/**
 * 按课的 id 重新计算顺序号(order),写回课文件和大纲:`npm run content:sync-order`。
 * 顺序规则见 packages/core/src/hours.ts 的 orderFromId。只改 order 这一项,不动其他内容和格式。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { orderFromId } from "../packages/core/src/hours";
import { languageCodes, lessonFiles, outlineFiles } from "./_content";

let changed = 0;
const fix = (text: string) =>
  // 每个 "id": "...", 后面最近的 "order": N 改成按 id 算出的值
  text.replace(/("id"\s*:\s*"([a-z]{2}\.[a-z0-9]+\.[a-z0-9]+)"[\s\S]*?"order"\s*:\s*)(\d+)/g, (all, head: string, id: string, n: string) => {
    const want = orderFromId(id);
    if (want === null || String(want) === n) return all;
    changed++;
    return `${head}${want}`;
  });

for (const code of languageCodes()) {
  for (const f of [...lessonFiles(code), ...outlineFiles(code)]) {
    const before = readFileSync(f, "utf8");
    const after = fix(before);
    if (after !== before) {
      JSON.parse(after);
      writeFileSync(f, after);
    }
  }
}
console.log(`更新了 ${changed} 个顺序号`);
