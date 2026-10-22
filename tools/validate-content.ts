/**
 * 内容检查:`npm run validate`。每门语言:语言包 + 全部课。有错误就退出码 1(CI 会拦下)。
 *
 * 分头写课时用的参数:
 *   --lang de                 只查德语
 *   --only de.a1u3,de.a1u4    只报告这些前缀的课的问题(别人还没写完的课不打扰你)
 * 有大纲(content/outlines/<lang>.json)时,还没写的课用大纲里的信息顶上,
 * 所以后面单元的课可以先写、先校验;写好的课的新词必须和大纲一致(词条总登记处)。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Outline, stubLesson } from "../packages/core/src/outline";
import { validateCourse, type Problem } from "../packages/core/src/validate";

const root = join(import.meta.dirname, "..", "content");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const onlyLang = arg("--lang");
const only = arg("--only")?.split(",").filter(Boolean);

let failed = 0;
for (const f of readdirSync(join(root, "languages")).sort()) {
  const code = f.replace(/\.json$/, "");
  if (onlyLang && code !== onlyLang) continue;
  const dir = join(root, "courses", code);
  const written = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")).map((x) => readJson(join(dir, x))) : [];
  const problems: Problem[] = [];

  let lessons: unknown[] = written;
  const outlinePath = join(root, "outlines", `${code}.json`);
  if (existsSync(outlinePath)) {
    const parsed = Outline.safeParse(readJson(outlinePath));
    if (!parsed.success) {
      problems.push({ lesson: "大纲", msg: parsed.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
    } else {
      const byId = new Map(written.map((l) => [(l as { id: string }).id, l as { id: string; newItems?: { id: string }[] }]));
      for (const o of parsed.data.lessons) {
        const w = byId.get(o.id);
        if (!w) continue;
        const a = (w.newItems ?? []).map((i) => i.id).sort().join(",");
        const b = o.newItems.map((i) => i.id).sort().join(",");
        if (a !== b) problems.push({ lesson: o.id, msg: `新词和大纲不一致。课里:${a};大纲:${b}` });
      }
      for (const id of byId.keys()) {
        if (!parsed.data.lessons.some((o) => o.id === id)) problems.push({ lesson: id, msg: "这节课不在大纲里" });
      }
      // 没写的课用大纲顶上
      lessons = [...written, ...parsed.data.lessons.filter((o) => !byId.has(o.id)).map(stubLesson)];
    }
  }

  problems.push(...validateCourse(readJson(join(root, "languages", f)), lessons));
  const shown = only ? problems.filter((p) => only.some((pre) => p.lesson.startsWith(pre))) : problems;
  console.log(`${code}: 已写 ${written.length} 课, ${shown.length} 个问题${only ? `(只看 ${only.join(",")})` : ""}`);
  for (const p of shown) console.log(`  [${p.lesson}] ${p.msg}`);
  failed += shown.length;
}
process.exit(failed ? 1 : 0);
