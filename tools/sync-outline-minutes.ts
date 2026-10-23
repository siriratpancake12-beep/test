/**
 * 把大纲里的课时改成已写好的课按内容算出的值:`npm run content:sync-minutes -- --lang fr [--write]`
 *
 * 大纲里的 estimatedMinutes 是写课前的估计,课写好以后以课文件为准(hours.ts 按内容算)。
 * 只改这一个数字,不重写整个文件(大纲是手排的格式,而且常有别人在定点修改)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { estimateLessonMinutes } from "../packages/core/src/hours";
import { Lesson } from "../packages/core/src/schema";
import { lessonFiles, outlineFiles, readJson } from "./_content";

const i = process.argv.indexOf("--lang");
const lang = i >= 0 ? process.argv[i + 1] : undefined;
const write = process.argv.includes("--write");
if (!lang) throw new Error("用法:npm run content:sync-minutes -- --lang fr [--write]");

const minutes = new Map<string, number>();
for (const f of lessonFiles(lang)) {
  const r = Lesson.safeParse(readJson(f));
  if (r.success) minutes.set(r.data.id, estimateLessonMinutes(r.data));
}

let changed = 0;
for (const path of outlineFiles(lang)) {
  let text = readFileSync(path, "utf8");
  let fileChanged = false;
  for (const [id, m] of minutes) {
    const at = text.indexOf(`"id": "${id}"`);
    if (at < 0) continue;
    // 只在这节课自己的对象里找:到下一节课的 id 为止
    const next = text.indexOf(`"id": "${lang}.`, at + 1);
    const end = next < 0 ? text.length : next;
    const seg = text.slice(at, end);
    const re = /"estimatedMinutes":\s*([\d.]+)/;
    const hit = re.exec(seg);
    if (!hit || Number(hit[1]) === m) continue;
    console.log(`${id}: ${hit[1]} → ${m}`);
    text = text.slice(0, at) + seg.replace(re, `"estimatedMinutes": ${m}`) + text.slice(end);
    fileChanged = true;
    changed++;
  }
  if (write && fileChanged) writeFileSync(path, text);
}
console.log(changed ? `${write ? "已改" : "要改(加 --write)"} ${changed} 节课的课时` : "大纲课时和课文件一致");
