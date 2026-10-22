/**
 * 课程时长报告:`npm run content:hours`。
 * "已写"按写好的课的实际内容算;"按大纲预计"把还没写的课按已写的同类课的平均时长估。
 * 算法见 packages/core/src/hours.ts(每一步按句数、词数、题数乘平均用时 + 复习 15% + 每单元练习和测评)。
 */
import { Lesson } from "../packages/core/src/schema";
import { courseHours, estimateLessonMinutes } from "../packages/core/src/hours";
import { stubLesson } from "../packages/core/src/outline";
import { languageCodes, lessonFiles, loadOutline, readJson } from "./_content";

const rows: string[] = ["| 语种 | 已写课 / 读物 | 已写时长 | 大纲课数 | 按大纲预计 |", "|---|---|---|---|---|"];
for (const code of languageCodes()) {
  const written = lessonFiles(code).map((f) => Lesson.safeParse(readJson(f))).filter((r) => r.success).map((r) => r.data!);
  const outline = loadOutline(code);
  if (!written.length && !outline) continue;
  const w = courseHours(written);
  const ids = new Set(written.map((l) => l.id));
  const planned = (outline?.lessons ?? []).filter((o) => !ids.has(o.id)).map(stubLesson);
  // 没写的课:按已写的同类课(课 / 读物)平均时长估;还没有样本时课按 20 分钟、读物按 8 分钟
  const avg = (reading: boolean) => {
    const xs = written.filter((l) => (l.type === "reading") === reading && l.lines.length > 0).map(estimateLessonMinutes);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : reading ? 8 : 20;
  };
  const plannedMin = planned.reduce((a, l) => a + avg(l.type === "reading") * 1.15, 0);
  const units = new Set([...written, ...planned].map((l) => l.unit)).size;
  const total = courseHours(written).totalHours + plannedMin / 60 + ((units - w.units) * 22) / 60;
  const levels = Object.entries(w.byLevel).map(([k, v]) => `${k} ${v}h`).join(" · ");
  rows.push(`| ${code} | ${w.lessons} / ${w.readers} | ${w.totalHours} h${levels ? `(${levels})` : ""} | ${written.length + planned.length} | ${Math.round(total)} h |`);
}
console.log(rows.join("\n"));
