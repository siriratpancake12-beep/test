/**
 * 课程内容加载压测:`npm run content:bench`(加 `-- --web` 再打包网页版看包的大小,要几分钟;`-- --keep` 保留临时文件)。
 *
 * 1. 用现有的课克隆出接近写满时的假内容:en fr de es ja ko 每门 550 节
 *    (A1 第 1–20 单元、A2 第 1–30 单元,每单元 8 课 + 读物 A1 2 篇、A2 3 篇,共 530 节;A2 前 20 个单元再各加一节 l09),
 *    id 按 <lang>.a1u3.l02 / <lang>.a2u15.r01 的规则编号,放在系统临时目录;
 * 2. 跑生成器(tools/gen-content-index.ts --content --out),报告每个语种生成文件的大小;
 * 3. 在 Node 里用 App 的 content/library.ts 加载生成的文件:第一次 getLessons 的耗时(JSON.parse + 建索引)、
 *    解析后占的内存,并和旧做法比(启动时把所有语种的每一节课都跑一遍 zod safeParse);
 *    另外比较同一份内容写成"JSON 字符串"和"对象字面量"两种模块:Hermes 字节码的大小(用 RN 带的 hermesc 编译)、
 *    V8 里加载的耗时和内存;
 * 4. 再用真实内容(content/)跑一遍;
 * 5. --web:`npm run build:web -w @lingo/mobile`(真实内容)报告网页包的大小;再用假的全量内容导出一次(输出到临时目录)。
 *
 * Node 的数字只能当相对参考:手机上的 Hermes 比 Node 慢几倍,但不用像 tsx 这样现场转译 TypeScript。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { orderFromId } from "../packages/core/src/hours";
import { Lesson } from "../packages/core/src/schema";
import { createLibrary, type ContentIndex } from "../apps/mobile/src/content/library";

const root = join(import.meta.dirname, "..");
const realContent = join(root, "content");
const mobile = join(root, "apps", "mobile");
const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const web = process.argv.includes("--web");
const keep = process.argv.includes("--keep");
const LANGS = ["en", "fr", "de", "es", "ja", "ko"];
const PER_LANG = 550;

// 量内存要先垃圾回收;不用加启动参数
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const tmp = mkdtempSync(join(tmpdir(), "lingo-bench-"));
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const ms = (n: number) => `${n.toFixed(1)} ms`;
const time = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
};
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

// ---- 1. 假的全量内容 ----

/** 一门课的课位:A1 20 个单元(8 课 + 2 篇读物)、A2 30 个单元(8 课 + 3 篇读物),不够 550 节就给 A2 的单元加第 9 课 */
function slots(n: number): { level: "a1" | "a2"; unit: number; id: string; reading: boolean }[] {
  const out: { level: "a1" | "a2"; unit: number; id: string; reading: boolean }[] = [];
  const units = [...Array.from({ length: 20 }, (_, i) => ["a1", i + 1] as const), ...Array.from({ length: 30 }, (_, i) => ["a2", i + 1] as const)];
  const pad = (k: number) => String(k).padStart(2, "0");
  for (const [level, unit] of units) {
    for (let k = 1; k <= 8; k++) out.push({ level, unit, id: `${level}u${unit}.l${pad(k)}`, reading: false });
    for (let k = 1; k <= (level === "a1" ? 2 : 3); k++) out.push({ level, unit, id: `${level}u${unit}.r${pad(k)}`, reading: true });
  }
  for (const [level, unit] of units.filter(([lv]) => lv === "a2")) {
    if (out.length >= n) break;
    out.push({ level, unit, id: `${level}u${unit}.l09`, reading: false });
  }
  return out.slice(0, n);
}

/** 把一个语种的 id(de.hallo)换成另一个语种的前缀 */
const relang = (id: string, lang: string, suffix = "") => `${lang}.${id.slice(3)}${suffix}`;

function fakeContent(dir: string) {
  cpSync(join(realContent, "languages"), join(dir, "languages"), { recursive: true });
  const sources: Record<string, unknown>[] = [];
  const scenarios: Record<string, unknown>[] = [];
  for (const code of readdirSync(join(realContent, "courses")).sort()) {
    for (const f of readdirSync(join(realContent, "courses", code)).filter((x) => x.endsWith(".json")).sort()) {
      sources.push(readJson(join(realContent, "courses", code, f)));
    }
  }
  for (const f of readdirSync(join(realContent, "scenarios")).filter((x) => x.endsWith(".json")).sort()) scenarios.push(...readJson(join(realContent, "scenarios", f)));
  const readers = sources.filter((l) => l.type === "reading");
  const others = sources.filter((l) => l.type !== "reading");
  let bytes = 0;
  for (const lang of LANGS) {
    mkdirSync(join(dir, "courses", lang), { recursive: true });
    slots(PER_LANG).forEach((slot, i) => {
      const src = structuredClone(slot.reading ? readers[i % readers.length]! : others[i % others.length]!) as Record<string, any>;
      const id = `${lang}.${slot.id}`;
      const theme = String(src.unit).replace(/^\S+\s*/, "");
      const lesson = {
        ...src,
        id,
        lang,
        cefr: slot.level.toUpperCase(),
        unit: `${slot.level.toUpperCase()}-${slot.unit} ${theme}`,
        order: orderFromId(id),
        // 词条 id 每节课都不一样(和真实课程一样,整门课的词条池有几千个)
        newItems: src.newItems.map((it: { id: string }) => ({ ...it, id: relang(it.id, lang, `_${i}`) })),
        reviewItems: (src.reviewItems ?? []).map((x: string) => relang(x, lang)),
        lines: (src.lines ?? []).map((ln: { items?: string[] }) => ({ ...ln, items: (ln.items ?? []).map((x) => relang(x, lang)) })),
      };
      const text = JSON.stringify(lesson, null, 2);
      bytes += Buffer.byteLength(text);
      writeFileSync(join(dir, "courses", lang, `${slot.id}.json`), text);
    });
    // 口语场景:现有的全部场景(约 24 个)换成这个语种
    mkdirSync(join(dir, "scenarios"), { recursive: true });
    const sc = scenarios.map((s, k) => ({ ...s, id: relang(String(s.id), lang, `_${k}`), lang }));
    writeFileSync(join(dir, "scenarios", `${lang}.json`), JSON.stringify(sc, null, 2));
  }
  return bytes;
}

// ---- 2、3. 生成并在 Node 里加载 ----

interface LangRow {
  lang: string; lessons: number; file: number; gzip: number; require: number; parse: number; pool: number; heap: number;
  hermes: { str: number; obj: number } | null;
}

function run(label: string, content: string, out: string) {
  const [, genMs] = time(() => execFileSync(process.execPath, [tsx, join(root, "tools", "gen-content-index.ts"), "--content", content, "--out", out], { stdio: "pipe" }));
  // 临时目录里的生成文件按 CommonJS 加载(和 Metro 一样,函数里的 require 第一次调用时才执行模块)
  writeFileSync(join(out, "package.json"), JSON.stringify({ type: "commonjs" }));
  return { label, genMs, out };
}

async function load(out: string) {
  const index = (await import(pathToFileURL(join(out, "index.generated.ts")).href)) as ContentIndex;
  const lib = createLibrary(index);
  const avail = lib.availableLangs().map((p) => p.code);
  const lazy = lib.loadedLangs().length === 0;
  const rows: LangRow[] = [];
  for (const lang of avail) {
    const file = statSync(join(out, `${lang}.generated.ts`)).size;
    const gzip = gzipSync(readFileSync(join(out, `${lang}.generated.ts`))).length;
    gc();
    const before = process.memoryUsage().heapUsed;
    // require:执行生成的模块(Node 里还包括 tsx 现场转译 TypeScript,手机上打包时已经编译好,没有这一步)
    const [, req] = time(() => index.loaders[lang]!());
    // 第一次 getLessons:JSON.parse + 按 id 建索引
    const [lessons, parse] = time(() => lib.getLessons(lang));
    const [, pool] = time(() => lib.itemPool(lang));
    gc();
    const heap = process.memoryUsage().heapUsed - before;
    rows.push({ lang, lessons: lessons.length, file, gzip, require: req, parse, pool, heap, hermes: hermesSizes(out, lang) });
  }
  return { rows, lazy, avail, lib };
}

/** 旧做法:启动时把所有语种的每一节课都跑一遍 zod safeParse(对象已经建好,只算校验) */
function oldStartup(content: string) {
  const raws: unknown[] = [];
  for (const code of readdirSync(join(content, "courses"))) {
    for (const f of readdirSync(join(content, "courses", code)).filter((x) => x.endsWith(".json"))) raws.push(readJson(join(content, "courses", code, f)));
  }
  const [, t] = time(() => raws.forEach((r) => Lesson.safeParse(r)));
  return { lessons: raws.length, ms: t };
}

function table(rows: LangRow[]) {
  const head = "| 语种 | 课数 | 生成文件 | gzip 后 | Hermes 字节码(现在 / 旧做法) | require(含 tsx 转译) | 第一次 getLessons(JSON.parse + 建索引) | itemPool | 解析后占内存 |";
  const hbc = (r: LangRow) => (r.hermes ? `${kb(r.hermes.str)} / ${kb(r.hermes.obj)}` : "(没有 hermesc)");
  const lines = rows.map((r) => `| ${r.lang} | ${r.lessons} | ${kb(r.file)} | ${kb(r.gzip)} | ${hbc(r)} | ${ms(r.require)} | ${ms(r.parse)} | ${ms(r.pool)} | ${mb(r.heap)} |`);
  const sum = (k: "file" | "gzip") => rows.reduce((a, r) => a + r[k], 0);
  const hsum = (k: "str" | "obj") => rows.reduce((a, r) => a + (r.hermes?.[k] ?? 0), 0);
  return [
    head, "|---|---|---|---|---|---|---|---|---|", ...lines,
    `| 合计 | ${rows.reduce((a, r) => a + r.lessons, 0)} | ${mb(sum("file"))} | ${mb(sum("gzip"))} | ${mb(hsum("str"))} / ${mb(hsum("obj"))} | | | | |`,
  ].join("\n");
}

/**
 * 原生包:用 React Native 带的 hermesc 把一个语种的内容编译成 Hermes 字节码(手机上跑的就是它),
 * 比较现在的"一个 JSON 字符串"和旧做法(Metro 把 JSON import 变成对象字面量)的大小。找不到 hermesc 就跳过。
 */
function hermesSizes(out: string, lang: string): { str: number; obj: number } | null {
  const dir = { linux: "linux64-bin", darwin: "osx-bin", win32: "win64-bin" }[process.platform as string];
  let hermesc: string;
  try {
    hermesc = join(dirname(require.resolve("hermes-compiler/package.json")), "hermesc", dir ?? "", process.platform === "win32" ? "hermesc.exe" : "hermesc");
  } catch {
    return null;
  }
  const data = readFileSync(join(out, `${lang}.generated.ts`), "utf8").match(/export const data: string = (".*");\n/)![1]!;
  const size = (name: string, js: string) => {
    writeFileSync(join(out, `${name}.js`), js);
    execFileSync(hermesc, ["-emit-binary", "-O", "-out", join(out, `${name}.hbc`), join(out, `${name}.js`)], { stdio: "pipe" });
    return statSync(join(out, `${name}.hbc`)).size;
  };
  return { str: size(`${lang}-str`, `globalThis.data = ${data};\n`), obj: size(`${lang}-obj`, `globalThis.data = ${JSON.parse(data)};\n`) };
}

/**
 * 同一份内容的两种写法在 V8 里加载:现在的"JSON 字符串 + JSON.parse",和旧做法的对象字面量(Metro 把 JSON import
 * 变成 module.exports = {...})。各开一个干净的 node 进程(不经过 tsx 转译),量 require(+ 解析)的耗时和之后占的内存。
 */
function v8Compare(out: string, lang: string) {
  const lit = readFileSync(join(out, `${lang}.generated.ts`), "utf8").match(/export const data: string = (".*");\n/)![1]!;
  const probe = (name: string, body: string, parse: boolean) => {
    const file = join(out, `${name}.cjs`);
    writeFileSync(file, `module.exports = ${body};\n`);
    const script = `gc(); const h0 = process.memoryUsage().heapUsed; const t0 = process.hrtime.bigint();
      let d = require(${JSON.stringify(file)}); ${parse ? "d = JSON.parse(d);" : ""}
      const t = Number(process.hrtime.bigint() - t0) / 1e6; gc();
      console.log(JSON.stringify({ t, heap: process.memoryUsage().heapUsed - h0, n: d.lessons.length }));`;
    return JSON.parse(execFileSync(process.execPath, ["--expose-gc", "-e", script]).toString()) as { t: number; heap: number };
  };
  const str = probe(`${lang}-v8-str`, lit, true);
  const obj = probe(`${lang}-v8-obj`, JSON.parse(lit) as string, false);
  return `V8 里加载 ${lang}(干净的 node 进程):JSON 字符串 require + JSON.parse ${ms(str.t)}、占内存 ${mb(str.heap)};` +
    `对象字面量 require ${ms(obj.t)}、占内存 ${mb(obj.heap)}`;
}

/** 网页包:各个 js 文件的大小,以及课程所在的那个文件 */
function webSize(dir: string, probe: string) {
  const js = join(dir, "_expo", "static", "js", "web");
  const files = readdirSync(js).filter((f) => f.endsWith(".js")).map((f) => {
    const buf = readFileSync(join(js, f));
    return { f, size: buf.length, gzip: gzipSync(buf).length, content: buf.includes(probe) };
  });
  const total = files.reduce((a, x) => a + x.size, 0);
  const gz = files.reduce((a, x) => a + x.gzip, 0);
  const withContent = files.filter((x) => x.content).map((x) => `${x.f.replace(/-[0-9a-f]{32}\.js$/, ".js")} ${mb(x.size)}(gzip ${mb(x.gzip)})`);
  return `${files.length} 个 js 共 ${mb(total)}(gzip ${mb(gz)});课程在:${withContent.join("、") || "没找到"}`;
}

try {
  const fake = join(tmp, "content");
  const srcBytes = fakeContent(fake);
  console.log(`假内容:${LANGS.length} 个语种 × ${PER_LANG} 节,课程 JSON 共 ${mb(srcBytes)} → ${fake}\n`);

  for (const [label, content] of [["假的全量内容", fake], ["真实内容(content/)", realContent]] as const) {
    const g = run(label, content, join(tmp, label.startsWith("假") ? "out-fake" : "out-real"));
    const { rows, lazy, avail, lib } = await load(g.out);
    const old = oldStartup(content);
    console.log(`## ${label}\n`);
    console.log(`生成器(构建时 zod 校验 + 写文件):${ms(g.genMs)}`);
    console.log(`availableLangs() 只看摘要:${lazy ? "没有加载任何语种的课" : "加载了课(不对!)"}(有课的语种:${avail.join(" ")})`);
    console.log(table(rows));
    const maxParse = Math.max(...rows.map((r) => r.parse));
    console.log(`\n现在启动时:0 节课要解析;打开某个语种时解析这一个语种(上表,最慢 ${ms(maxParse)})。`);
    console.log(`旧做法启动时:所有语种 ${old.lessons} 节课逐节 zod safeParse ${ms(old.ms)}(还不算把 ${old.lessons} 节课建成对象的时间)。`);
    const last = rows.at(-1);
    if (last) {
      const [, get] = time(() => lib.getLesson(lib.getLessons(last.lang).at(-1)!.id));
      console.log(`getLesson(按 Map 查,已加载):${ms(get)}`);
      console.log(`${v8Compare(g.out, rows[0]!.lang)}\n`);
    }
  }

  if (web) {
    console.log("## 网页包\n");
    const [, t1] = time(() => execFileSync("npm", ["run", "build:web", "-w", "@lingo/mobile"], { cwd: root, stdio: "pipe" }));
    console.log(`真实内容(npm run build:web,${(t1 / 1000).toFixed(0)} 秒):${webSize(join(mobile, "dist-web"), "de.a1u1.l01")}`);
    // 假的全量内容:打包器按 LINGO_CONTENT_DIR 生成;导出到临时目录,不动 dist-web
    const outWeb = join(tmp, "web-full");
    try {
      const [, t2] = time(() => execFileSync("npx", ["expo", "export", "--platform", "web", "--output-dir", outWeb, "--clear"], {
        cwd: mobile, stdio: "pipe", env: { ...process.env, LINGO_CONTENT_DIR: fake },
      }));
      console.log(`假的全量内容(${(t2 / 1000).toFixed(0)} 秒):${webSize(outWeb, "en.a1u1.l01")}`);
    } finally {
      // App 目录里的生成文件换回真实内容
      execFileSync(process.execPath, [tsx, join(root, "tools", "gen-content-index.ts")], { cwd: root, stdio: "pipe" });
    }
  }
} finally {
  if (keep) console.log(`\n临时文件保留在 ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
