/**
 * 课程进度一览:`npm run content:status [-- --lang de]`
 *
 * 按单元列出每门语言写好了几节(A1 每单元 8 课 + 2 篇读物,A2 每单元 8 课 + 3 篇读物),
 * 大纲里登记了几节、单元规划(plan*.json)里有没有。接手的人先跑这个,就知道从哪儿接着写。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { contentRoot, languageCodes, lessonFiles, loadOutline, readJson } from "./_content";

const i = process.argv.indexOf("--lang");
const only = i >= 0 ? process.argv[i + 1] : undefined;
const UNITS = { a1: 20, a2: 30 } as const;
const PER_UNIT = { a1: 10, a2: 11 } as const;

for (const code of languageCodes()) {
  if (only && code !== only) continue;
  const dir = join(contentRoot, "courses", code);
  if (!existsSync(dir) && !existsSync(join(contentRoot, "outlines", `${code}.json`)) && !existsSync(join(contentRoot, "outlines", code))) continue;
  const written = new Set(lessonFiles(code).map((f) => (readJson(f) as { id: string }).id));
  const outlined = new Set((loadOutline(code)?.lessons ?? []).map((l) => l.id));
  const planned = new Set<string>();
  const planDir = join(contentRoot, "outlines", code);
  if (existsSync(planDir)) {
    for (const f of readdirSync(planDir).filter((x) => x.startsWith("plan") && x.endsWith(".json"))) {
      for (const u of (readJson(join(planDir, f)) as { units?: { lessons?: { id: string }[] }[] }).units ?? []) {
        for (const l of u.lessons ?? []) planned.add(l.id);
      }
    }
  }
  if (!written.size && !outlined.size) continue;
  console.log(`\n## ${code}:已写 ${written.size} 节,大纲登记 ${outlined.size} 节,规划 ${planned.size} 条`);
  for (const lv of ["a1", "a2"] as const) {
    const rows: string[] = [];
    const untouched: number[] = []; // 有规划、还没登记也没写的单元,合并成一段显示
    let full = 0;
    for (let u = 1; u <= UNITS[lv]; u++) {
      const pre = `${code}.${lv}u${u}.`;
      const w = [...written].filter((id) => id.startsWith(pre)).length;
      const o = [...outlined].filter((id) => id.startsWith(pre)).length;
      const p = [...planned].filter((id) => id.startsWith(pre)).length;
      if (w >= PER_UNIT[lv]) full++;
      if (!w && !o) {
        if (p) untouched.push(u);
        continue;
      }
      rows.push(`${lv}u${u} ${w}/${PER_UNIT[lv]}${o !== w ? `(大纲 ${o})` : ""}${!p && w < PER_UNIT[lv] ? "(无规划)" : ""}`);
    }
    const range = untouched.length ? `;有规划、还没开写:${lv}u${untouched[0]}–${lv}u${untouched[untouched.length - 1]}(${untouched.length} 个单元)` : "";
    if (rows.length || range) console.log(`${lv.toUpperCase()} 写满的单元 ${full}/${UNITS[lv]}:${rows.join(" · ") || "无"}${range}`);
  }
}
