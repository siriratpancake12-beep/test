/**
 * 内容检查:`npm run validate`。每门语言:语言包 + 全部课。有错误就退出码 1(CI 会拦下)。
 *
 * 分头写课时用的参数:
 *   --lang de                 只查德语
 *   --only de.a1u3,de.a1u4    只报告这些前缀的课的问题(别人还没写完的课不打扰你)
 *   --strict                  另外检查课的顺序号(order 必须等于按 id 算出的值,用 npm run content:sync-order 修正)
 * 有大纲(content/outlines/)时,还没写的课用大纲里的信息顶上,
 * 所以后面单元的课可以先写、先校验;写好的课的新词必须和大纲一致(词条总登记处)。
 */
import { orderFromId } from "../packages/core/src/hours";
import { stubLesson } from "../packages/core/src/outline";
import { validateCourse, type Problem } from "../packages/core/src/validate";
import { languageCodes, lessonFiles, loadOutline, loadPackRaw, readJson } from "./_content";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const onlyLang = arg("--lang");
const only = arg("--only")?.split(",").filter(Boolean);
const strict = process.argv.includes("--strict");

let failed = 0;
for (const code of languageCodes()) {
  if (onlyLang && code !== onlyLang) continue;
  const written = lessonFiles(code).map(readJson) as { id: string; order?: number; newItems?: { id: string }[] }[];
  const problems: Problem[] = [];

  let lessons: unknown[] = written;
  const outline = loadOutline(code);
  if (outline) {
    for (const e of outline.errors) problems.push({ lesson: "大纲", msg: e });
    const byId = new Map(written.map((l) => [l.id, l]));
    for (const o of outline.lessons) {
      const w = byId.get(o.id);
      if (!w) continue;
      const a = (w.newItems ?? []).map((i) => i.id).sort().join(",");
      const b = o.newItems.map((i) => i.id).sort().join(",");
      if (a !== b) problems.push({ lesson: o.id, msg: `新词和大纲不一致。课里:${a};大纲:${b}` });
    }
    for (const id of byId.keys()) {
      if (!outline.lessons.some((o) => o.id === id)) problems.push({ lesson: id, msg: "这节课不在大纲里" });
    }
    // 没写的课用大纲顶上
    lessons = [...written, ...outline.lessons.filter((o) => !byId.has(o.id)).map(stubLesson)];
  }
  if (strict) {
    for (const l of lessons as { id: string; order: number }[]) {
      const want = orderFromId(l.id);
      if (want === null) problems.push({ lesson: l.id, msg: "课 id 格式不对(应为 <语种>.a1u3.l02 或 <语种>.a2u15.r01)" });
      else if (l.order !== want) problems.push({ lesson: l.id, msg: `order 应为 ${want}(运行 npm run content:sync-order)` });
    }
  }

  // 排序一律按 id 推出的顺序(文件里存的 order 可能还是旧的;--strict 会单独报出来)
  const ordered = (lessons as { id: string; order: number }[]).map((l) => ({ ...l, order: orderFromId(l.id) ?? l.order }));
  problems.push(...validateCourse(loadPackRaw(code), ordered));
  const shown = only ? problems.filter((p) => only.some((pre) => p.lesson.startsWith(pre))) : problems;
  console.log(`${code}: 已写 ${written.length} 课, ${shown.length} 个问题${only ? `(只看 ${only.join(",")})` : ""}`);
  for (const p of shown) console.log(`  [${p.lesson}] ${p.msg}`);
  failed += shown.length;
}
process.exit(failed ? 1 : 0);
