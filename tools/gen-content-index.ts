/**
 * 生成 App 的内容索引(apps/mobile/src/content.generated.ts)。
 * React Native 的打包器只认静态 import,所以每次加课后跑一次 `npm run content:index`。
 * 正式版课程会改成从服务器/CDN 下载,这个文件只用于内置的示例课程和离线首包。
 */
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const content = join(root, "content");
const out = join(root, "apps", "mobile", "src", "content.generated.ts");
const rel = (p: string) => "../../../content/" + p;

const imports: string[] = [];
const packs: string[] = [];
const courses: string[] = [];
let n = 0;
for (const f of readdirSync(join(content, "languages")).sort()) {
  const code = f.replace(/\.json$/, "");
  const v = `p_${code}`;
  imports.push(`import ${v} from "${rel(`languages/${f}`)}";`);
  packs.push(`  ${v},`);
  const dir = join(content, "courses", code);
  const ls = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")).sort() : [];
  const vars = ls.map((x) => {
    const lv = `l${n++}`;
    imports.push(`import ${lv} from "${rel(`courses/${code}/${x}`)}";`);
    return lv;
  });
  courses.push(`  ${code}: [${vars.join(", ")}],`);
}
// AI 口语场景:content/scenarios/<lang>.json
const scenarios: string[] = [];
const scenarioDir = join(content, "scenarios");
if (existsSync(scenarioDir)) {
  for (const f of readdirSync(scenarioDir).filter((x) => x.endsWith(".json")).sort()) {
    const v = `s_${f.replace(/\.json$/, "")}`;
    imports.push(`import ${v} from "${rel(`scenarios/${f}`)}";`);
    scenarios.push(`  ${f.replace(/\.json$/, "")}: ${v} as unknown[],`);
  }
}
writeFileSync(
  out,
  `// 由 tools/gen-content-index.ts 生成,不要手改。\n${imports.join("\n")}\n\nexport const rawPacks: unknown[] = [\n${packs.join("\n")}\n];\n\n` +
    `export const rawLessons: Record<string, unknown[]> = {\n${courses.join("\n")}\n};\n\n` +
    `export const rawScenarios: Record<string, unknown[]> = {\n${scenarios.join("\n")}\n};\n`,
);
console.log("wrote", out);
