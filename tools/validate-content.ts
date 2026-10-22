/**
 * 内容检查:node 跑 `npm run validate`。每门语言:语言包 + 全部课。有错误就退出码 1(CI 会拦下)。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateCourse } from "../packages/core/src/validate";

const root = join(import.meta.dirname, "..", "content");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
let failed = 0;
for (const f of readdirSync(join(root, "languages"))) {
  const code = f.replace(/\.json$/, "");
  const dir = join(root, "courses", code);
  const lessons = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")).map((x) => readJson(join(dir, x))) : [];
  const problems = validateCourse(readJson(join(root, "languages", f)), lessons);
  console.log(`${code}: ${lessons.length} 课, ${problems.length} 个问题`);
  for (const p of problems) console.log(`  [${p.lesson}] ${p.msg}`);
  failed += problems.length;
}
process.exit(failed ? 1 : 0);
