/**
 * 生成 App 内置的课程内容:`npm run content:index`。生成的文件不提交(.gitignore),
 * 打包、导出、启动开发服务器(apps/mobile/metro.config.js)和 App 类型检查(pretypecheck)之前都会自动跑一遍。
 *
 * 为什么不再直接 import 课程 JSON:写满以后 6 门语言约 3,300 节课、20MB 以上。全部静态 import 的话,
 * App 一启动就要把所有语种的课都建成对象、再逐节跑 zod 校验,手机上又慢又占内存。现在:
 * - 构建时就用和 App 同一套 zod schema 解析每个语言包、课、场景(默认值在这里填好),格式不对就列出来、退出码 1,
 *   App 运行时不用再校验;
 * - 课按 id 推出的顺序(core/hours.ts 的 orderFromId)排好,order 也改成这个值(和 npm run validate 一致);
 * - index.generated.ts 只放语言包(很小)、每个语种的摘要(课数、等级、场景数)和按语种懒加载的函数;
 * - <语种>.generated.ts 把这个语种的课和场景存成一个压缩的 JSON 字符串,第一次用到这个语种时才 require、
 *   才 JSON.parse(Metro 的模块工厂只在第一次 require 时执行)。JSON.parse 一般比执行同样大的对象字面量快;
 *   代价是 Hermes 字节码里字符串更占地方,压测结果和取舍见 docs/02-新系统架构设计.md。
 *
 * 参数(压测用):--content <目录>(默认 content/)、--out <目录>(默认 apps/mobile/src/content/)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ZodType } from "zod";
import { orderFromId } from "../packages/core/src/hours";
import { Scenario } from "../packages/core/src/scenario";
import { LanguagePack, Lesson } from "../packages/core/src/schema";

const root = join(import.meta.dirname, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const contentDir = resolve(arg("--content") ?? join(root, "content"));
const outDir = resolve(arg("--out") ?? join(root, "apps", "mobile", "src", "content"));
const t0 = performance.now();

const errors: string[] = [];
const rel = (f: string) => relative(contentDir, f);

/** 读一个 JSON 文件并用 schema 解析;出错记下来(一个文件最多列 8 条),返回 null */
function parseFile<T>(schema: ZodType<T>, file: string): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    errors.push(`${rel(file)}: 不是合法的 JSON(${(e as Error).message})`);
    return null;
  }
  return parseValue(schema, raw, rel(file));
}

function parseValue<T>(schema: ZodType<T>, raw: unknown, where: string): T | null {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  errors.push(`${where}: ${r.error.issues.slice(0, 8).map((x) => `${x.path.join(".") || "(根)"}: ${x.message}`).join("; ")}`);
  return null;
}

const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);

interface LangOut {
  code: string;
  lessons: Lesson[];
  scenarios: Scenario[];
}

const packs: LanguagePack[] = [];
const langs: LangOut[] = [];
for (const f of jsonFiles(join(contentDir, "languages"))) {
  const code = f.replace(/\.json$/, "");
  const pack = parseFile(LanguagePack, join(contentDir, "languages", f));
  if (!pack) continue;
  if (pack.code !== code) {
    errors.push(`languages/${f}: code 是 ${pack.code},和文件名不一致`);
    continue;
  }
  packs.push(pack);

  // App 按 id 的前两个字母找语种(getLesson("de.a1u1.l01") 只加载德语),所以 lang 和 id 前缀必须和目录一致
  const lessons: Lesson[] = [];
  const seen = new Set<string>();
  const dir = join(contentDir, "courses", code);
  for (const x of jsonFiles(dir)) {
    const l = parseFile(Lesson, join(dir, x));
    if (!l) continue;
    if (l.lang !== code || !l.id.startsWith(`${code}.`)) {
      errors.push(`courses/${code}/${x}: 课 ${l.id}(lang ${l.lang})不属于 ${code}`);
      continue;
    }
    if (seen.has(l.id)) errors.push(`courses/${code}/${x}: 课 id 重复:${l.id}`);
    seen.add(l.id);
    lessons.push({ ...l, order: orderFromId(l.id) ?? l.order });
  }
  // 顺序号相同(id 不合规则、手填重了)时按 id 排,每次生成的结果都一样
  lessons.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

  const scenarios: Scenario[] = [];
  const sf = join(contentDir, "scenarios", `${code}.json`);
  if (existsSync(sf)) {
    let list: unknown;
    try {
      list = JSON.parse(readFileSync(sf, "utf8"));
    } catch (e) {
      errors.push(`${rel(sf)}: 不是合法的 JSON(${(e as Error).message})`);
    }
    if (list !== undefined && !Array.isArray(list)) errors.push(`${rel(sf)}: 应该是一个数组`);
    else if (Array.isArray(list)) {
      list.forEach((raw, i) => {
        const s = parseValue(Scenario, raw, `${rel(sf)} 第 ${i + 1} 个场景`);
        if (!s) return;
        if (s.lang !== code || !s.id.startsWith(`${code}.`)) errors.push(`${rel(sf)}: 场景 ${s.id}(lang ${s.lang})不属于 ${code}`);
        else scenarios.push(s);
      });
    }
  }
  langs.push({ code, lessons, scenarios });
}
for (const f of jsonFiles(join(contentDir, "scenarios"))) {
  if (!packs.some((p) => `${p.code}.json` === f)) errors.push(`scenarios/${f}: 没有对应的语言包`);
}
if (!packs.length) errors.push(`${contentDir} 下没有语言包(languages/*.json)`);

if (errors.length) {
  console.error(`内容格式错误 ${errors.length} 处,没有生成 App 内容:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

/**
 * 生成的代码里的字符串字面量。JSON.stringify 的结果就是合法的 JS 字符串;U+2028/U+2029 在老的 JS 引擎里不能直接
 * 出现在字符串里,转义掉。中文保持原样,生成的文件小一些。
 */
const SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");
const escapeSeparators = (js: string) => js.replace(SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
const literal = (s: string) => escapeSeparators(JSON.stringify(s));
const code = (v: unknown, indent?: number) => escapeSeparators(JSON.stringify(v, null, indent));
const HEADER = "// 由 tools/gen-content-index.ts 生成,不要手改,也不提交(npm run content:index 重新生成)。";

/** 要写的文件:文件名 → 内容 */
const files = new Map<string, string>();
const summaries: Record<string, unknown> = {};
const loaders: string[] = [];
const report: string[] = [];
for (const { code: lang, lessons, scenarios } of langs) {
  const levels = [...new Set(lessons.map((l) => l.cefr))];
  summaries[lang] = {
    lessons: lessons.length,
    units: new Set(lessons.map((l) => l.unit)).size,
    levels,
    scenarios: scenarios.length,
  };
  // 没课也没场景的语种("即将上线")不生成文件,摘要就够了
  if (!lessons.length && !scenarios.length) continue;
  const data = JSON.stringify({ lessons, scenarios });
  files.set(
    `${lang}.generated.ts`,
    `${HEADER}\n// ${lang}:${lessons.length} 节课、${scenarios.length} 个口语场景(构建时已校验,默认值已填好)。` +
      `第一次用到这个语种时由 library.ts 用 JSON.parse 解析。\nexport const data: string = ${literal(data)};\n`,
  );
  loaders.push(`  ${lang}: () => (require("./${lang}.generated") as LangModule).data,`);
  report.push(`${lang} ${lessons.length} 课 ${scenarios.length} 场景 ${(Buffer.byteLength(data) / 1024).toFixed(0)}KB`);
}

files.set(
  "index.generated.ts",
  `${HEADER}
// 这里只有小的东西:启动时会加载。各语种的课和场景在 <语种>.generated.ts,用到时才加载。
import type { LanguagePack } from "@lingo/core";
import type { LangSummary } from "./library";

type LangModule = { data: string };

/** 语言包(构建时已校验,默认值已填好) */
export const packs: LanguagePack[] = ${code(packs, 2)};

/** 每个语种的摘要:不加载课也知道有没有课、有哪些等级、有没有口语场景 */
export const summaries: Record<string, LangSummary> = {
${Object.entries(summaries).map(([k, v]) => `  ${k}: ${code(v)},`).join("\n")}
};

/**
 * 按语种懒加载,返回这个语种的课和场景(JSON 字符串)。require 写在函数里:Metro 打包时照样把模块打进去,
 * 但模块代码在第一次 require 时才执行,没用到的语种不占启动时间。
 */
export const loaders: Record<string, () => string> = {
${loaders.join("\n")}
};
`,
);

mkdirSync(outDir, { recursive: true });
// 只写变了的文件:开发服务器开着时,内容没变就不会触发 App 刷新
let written = 0;
for (const [f, text] of files) {
  const p = join(outDir, f);
  if (existsSync(p) && readFileSync(p, "utf8") === text) continue;
  writeFileSync(p, text);
  written++;
}
// 语种没有内容了,它以前的生成文件不能留着
for (const f of readdirSync(outDir)) if (f.endsWith(".generated.ts") && !files.has(f)) rmSync(join(outDir, f));

const shown = outDir.startsWith(process.cwd()) ? relative(process.cwd(), outDir) || "." : outDir;
console.log(
  `App 内容已生成 → ${shown}(${Math.round(performance.now() - t0)} ms,${written ? `更新了 ${written} 个文件` : "没有变化"}):` +
    `${report.join(" · ") || "没有课"}`,
);
