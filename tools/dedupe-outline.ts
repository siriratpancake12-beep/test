/**
 * 大纲和课程去重:`npm run content:dedupe -- --lang de [--write]`
 *
 * 几个人同时写同一门语言不同单元时,难免重复教同一个词。按课程顺序走一遍:
 * 后面的课里再次出现的词(同一个 id,或者同样的写法、词性和意思)从新词里去掉,改成复习前面那个词,
 * 并把所有课(大纲和已经写好的课文件)里对重复 id 的引用改成原来的 id——包括课文句子的 items。
 *
 * "意思一样"按中文释义的字重合判断:die Bank(银行)和 die Bank(长椅)不会被合并。
 * 不加 --write 只报告不修改。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { orderFromId } from "../packages/core/src/hours";
import type { Item } from "../packages/core/src/schema";
import { lessonFiles, outlineFiles, readJson } from "./_content";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const lang = arg("--lang");
const write = process.argv.includes("--write");
if (!lang) throw new Error("用法:npm run content:dedupe -- --lang de [--write]");

type Lesson = { id: string; order: number; newItems: Item[]; reviewItems?: string[]; lines?: { items?: string[] }[] };
type OutlineFile = { path: string; data: { lessons: Lesson[] } };
type LessonFile = { path: string; data: Lesson };

const outlines: OutlineFile[] = outlineFiles(lang).map((path) => ({ path, data: readJson(path) }));
const written: LessonFile[] = lessonFiles(lang).map((path) => ({ path, data: readJson(path) }));


// 写好的课以课文件为准(词条的写法和释义比大纲新,判断"意思一样"更准);还没写的课用大纲
const byId = new Map<string, Lesson>();
for (const f of outlines) for (const l of f.data.lessons) byId.set(l.id, l);
for (const l of written.map((f) => f.data)) byId.set(l.id, l);
const ord = (l: Lesson) => orderFromId(l.id) ?? l.order;
const all = [...byId.values()].sort((a, b) => ord(a) - ord(b));

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[.,!?¿¡;:"'’«»()…。、!?]/g, "").replace(/\s+/g, " ").trim();
const hanzi = (s: string) => new Set([...s].filter((c) => /\p{Script=Han}/u.test(c)));
function sameSense(a: Item, b: Item): boolean {
  const x = hanzi(a.zh), y = hanzi(b.zh);
  if (!x.size || !y.size) return norm(a.zh) === norm(b.zh);
  const common = [...x].filter((c) => y.has(c)).length;
  return common / Math.min(x.size, y.size) >= 0.5;
}

const firstById = new Map<string, Item>();
const firstByText = new Map<string, Item[]>();
const remap = new Map<string, string>();
const dropped = new Map<string, Set<string>>(); // 课 id → 去掉的词条 id
const report: string[] = [];
const thin: string[] = [];

for (const l of all) {
  for (const it of l.newItems) {
    const key = `${it.pos}:${norm(it.text)}`;
    const original = firstById.get(it.id) ?? (firstByText.get(key) ?? []).find((o) => sameSense(o, it));
    if (original) {
      if (original.id !== it.id) remap.set(it.id, original.id);
      if (!dropped.has(l.id)) dropped.set(l.id, new Set());
      dropped.get(l.id)!.add(it.id);
      report.push(`${l.id}: 去掉重复的 ${it.id}(${it.text}),改为复习 ${original.id}`);
      continue;
    }
    firstById.set(it.id, it);
    firstByText.set(key, [...(firstByText.get(key) ?? []), it]);
  }
}

/** 对一节课(大纲条目或课文件)应用去重结果 */
function apply(l: Lesson): boolean {
  const before = JSON.stringify(l);
  const drop = dropped.get(l.id);
  if (drop) {
    const removed = l.newItems.filter((it) => drop.has(it.id));
    l.newItems = l.newItems.filter((it) => !drop.has(it.id));
    l.reviewItems = [...(l.reviewItems ?? []), ...removed.map((it) => remap.get(it.id) ?? it.id)];
    if (l.newItems.length < 3) thin.push(`${l.id} 去重后只剩 ${l.newItems.length} 个新词,需要补词`);
  }
  const fix = (id: string) => remap.get(id) ?? id;
  const review = [...new Set((l.reviewItems ?? []).map(fix))].filter((id) => !l.newItems.some((n) => n.id === id));
  // 原来没有 reviewItems 字段、也没有要加的,就不加(避免无谓地改写文件)
  if (l.reviewItems || review.length) l.reviewItems = review;
  for (const line of l.lines ?? []) if (line.items) line.items = [...new Set(line.items.map(fix))];
  return JSON.stringify(l) !== before;
}

const changedFiles: { path: string; data: unknown }[] = [];
for (const f of outlines) if (f.data.lessons.map(apply).some(Boolean)) changedFiles.push(f);
for (const f of written) if (apply(f.data)) changedFiles.push(f);

console.log(report.length ? report.join("\n") : "没有重复的词");
if (thin.length) console.log(`\n注意:\n${[...new Set(thin)].join("\n")}`);
if (write && changedFiles.length) {
  for (const f of changedFiles) writeFileSync(f.path, `${JSON.stringify(f.data, null, 2)}\n`);
  console.log(`\n已写回 ${changedFiles.length} 个文件`);
} else if (changedFiles.length) {
  console.log(`\n(加 --write 会改 ${changedFiles.length} 个文件)`);
}

