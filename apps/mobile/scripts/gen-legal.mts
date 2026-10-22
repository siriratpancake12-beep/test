/**
 * 把 docs/legal/*.md(协议正文,律师审的就是这一份)转成 App 内显示用的 TS 模块(apps/mobile/src/legal/)。
 * 改协议只改 Markdown,然后在仓库根目录运行:
 *
 *   npx tsx apps/mobile/scripts/gen-legal.mts           # 重新生成
 *   npx tsx apps/mobile/scripts/gen-legal.mts --check   # 只检查生成的文件是不是最新的(适合放进 CI)
 *
 * 只支持协议用得到的 Markdown:# 标题(第一行)、## / ### 小标题、> 引用、- 和 1. 列表(可缩进一级)、
 * 表格、**加粗**、[文字](另一份协议.md 或 https 链接)。<!-- 注释 --> 不会出现在 App 里。
 * 格式写错(加粗不成对、链接指向不存在的文件、表格列数不对)会直接报错,不会悄悄生成错的内容。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LegalBlock, LegalDoc, LegalKey } from "../src/legal/types";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC_DIR = join(ROOT, "docs", "legal");
const OUT_DIR = join(import.meta.dirname, "..", "src", "legal");

/** 文件名 → App 里的 doc 参数(/legal?doc=privacy)。顺序也是协议列表页的顺序 */
const DOCS: { key: LegalKey; file: string }[] = [
  { key: "terms", file: "用户协议.md" },
  { key: "privacy", file: "隐私政策.md" },
  { key: "renewal", file: "自动续费服务规则.md" },
  { key: "minors", file: "未成年人个人信息保护说明.md" },
  { key: "sdk", file: "第三方SDK清单.md" },
  { key: "permissions", file: "权限使用说明.md" },
];

function fail(file: string, line: number, msg: string): never {
  throw new Error(`docs/legal/${file} 第 ${line} 行:${msg}`);
}

/** 检查并改写行内标记:链接到 .md 的改成 doc:key */
function inline(text: string, file: string, line: number): string {
  if ((text.match(/\*\*/g) ?? []).length % 2) fail(file, line, "**加粗** 没有成对");
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, target: string) => {
    if (/^https?:\/\//.test(target)) return `[${label}](${target})`;
    const doc = DOCS.find((d) => d.file === target);
    if (!doc) fail(file, line, `链接 ${target} 不是 docs/legal 下的协议,也不是 https 网址`);
    return `[${label}](doc:${doc.key})`;
  });
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function parse(key: LegalKey, file: string): LegalDoc {
  const raw = readFileSync(join(SRC_DIR, file), "utf8").replace(/\r\n/g, "\n");
  // 去掉注释,但保留换行,报错时行号才对得上
  const lines = raw.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, "")).split("\n");
  const blocks: LegalBlock[] = [];
  let title = "";
  let i = 0;
  const at = () => i + 1;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    if (!title) {
      if (!trimmed.startsWith("# ")) fail(file, at(), "第一行必须是 # 标题");
      title = trimmed.slice(2).trim();
      i++;
      continue;
    }
    if (/^#\s/.test(trimmed)) fail(file, at(), "只能有一个 # 标题,小标题用 ## 或 ###");
    const h = trimmed.match(/^(#{2,4})\s+(.*)$/);
    if (h) {
      blocks.push({ t: h[1]!.length === 2 ? "h2" : "h3", text: inline(h[2]!, file, at()) });
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      const note: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        const t = lines[i]!.trim().replace(/^>\s?/, "");
        if (t) note.push(inline(t, file, at()));
        i++;
      }
      blocks.push({ t: "note", lines: note });
      continue;
    }
    if (trimmed.startsWith("|")) {
      const start = at();
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(cells(lines[i]!).map((c) => inline(c, file, at())));
        i++;
      }
      const [head, sep, ...body] = rows;
      if (!head || !sep || !sep.every((c) => /^:?-{3,}:?$/.test(c))) fail(file, start, "表格第二行必须是 | --- | --- |");
      for (const [k, r] of body.entries()) if (r.length !== head.length) fail(file, start + 2 + k, `这一行有 ${r.length} 列,表头有 ${head.length} 列`);
      if (!body.length) fail(file, start, "表格没有内容");
      blocks.push({ t: "table", head, rows: body });
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const level = li[1]!.length >= 2 ? 2 : 1;
      blocks.push({ t: "li", text: inline(li[3]!, file, at()), mark: /^\d/.test(li[2]!) ? li[2]! : "•", level });
      i++;
      continue;
    }
    // 普通段落:连续的几行合成一段(中文之间不加空格)
    let text = trimmed;
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(#|>|\||\s*([-*]|\d+\.)\s)/.test(lines[i]!)) {
      const next = lines[i]!.trim();
      text += /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(next) ? ` ${next}` : next;
      i++;
    }
    blocks.push({ t: "p", text: inline(text, file, i) });
  }
  if (!title) fail(file, 1, "文件是空的");
  // 页面标题用文件名;中文和英文之间加空格(第三方SDK清单 → 第三方 SDK 清单),和 App 里其他文字一致
  const short = file.replace(/\.md$/, "").replace(/([一-鿿])([A-Za-z0-9])/g, "$1 $2").replace(/([A-Za-z0-9])([一-鿿])/g, "$1 $2");
  return { key, short, title, source: `docs/legal/${file}`, blocks };
}

const HEADER = (src: string) =>
  `// 由 apps/mobile/scripts/gen-legal.mts 根据 ${src} 生成,不要手改。\n` +
  `// 改协议请改 Markdown,然后在仓库根目录运行:npx tsx apps/mobile/scripts/gen-legal.mts\n`;

function moduleSource(doc: LegalDoc): string {
  const blocks = doc.blocks.map((b) => `    ${JSON.stringify(b)},`).join("\n");
  return `${HEADER(doc.source)}import type { LegalDoc } from "./types";

export const ${doc.key}: LegalDoc = {
  key: ${JSON.stringify(doc.key)},
  short: ${JSON.stringify(doc.short)},
  title: ${JSON.stringify(doc.title)},
  source: ${JSON.stringify(doc.source)},
  blocks: [
${blocks}
  ],
};
`;
}

function indexSource(): string {
  return `${HEADER("docs/legal/*.md")}import type { LegalDoc, LegalKey } from "./types";
${DOCS.map((d) => `import { ${d.key} } from "./${d.key}";`).join("\n")}

/** 全部协议,按 /legal?doc=<key> 取 */
export const LEGAL_DOCS: Record<LegalKey, LegalDoc> = { ${DOCS.map((d) => d.key).join(", ")} };

/** 协议列表页的顺序 */
export const LEGAL_KEYS: LegalKey[] = [${DOCS.map((d) => JSON.stringify(d.key)).join(", ")}];

export const isLegalKey = (k: string | undefined): k is LegalKey => !!k && (LEGAL_KEYS as string[]).includes(k);
`;
}

const outputs = new Map<string, string>();
for (const d of DOCS) outputs.set(join(OUT_DIR, `${d.key}.ts`), moduleSource(parse(d.key, d.file)));
outputs.set(join(OUT_DIR, "index.ts"), indexSource());

if (process.argv.includes("--check")) {
  const stale = [...outputs].filter(([path, src]) => {
    try {
      return readFileSync(path, "utf8") !== src;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`协议的 TS 模块不是最新的,请运行 npx tsx apps/mobile/scripts/gen-legal.mts:\n${stale.map(([p]) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("✓ 协议的 TS 模块是最新的");
} else {
  for (const [path, src] of outputs) writeFileSync(path, src);
  for (const d of DOCS) console.log(`✓ ${d.file} → src/legal/${d.key}.ts`);
}
