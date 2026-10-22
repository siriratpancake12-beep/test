/**
 * 大纲去重:`npm run content:dedupe -- --lang de [--write]`
 *
 * 几个人同时写同一门语言不同单元的大纲时,难免重复教同一个词。按课程顺序走一遍:
 * 后面的课里再次出现的词(同一个 id,或者同样的写法、词性和意思)从新词里去掉,改成复习前面那个词,
 * 并把其他课里对重复 id 的引用改成原来的 id。只改大纲,不改已经写好的课(写课前先去重)。
 *
 * "意思一样"按中文释义的字重合判断:die Bank(银行)和 die Bank(长椅)不会被合并。
 * 不加 --write 只报告不修改。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { orderFromId } from "../packages/core/src/hours";
import type { Item } from "../packages/core/src/schema";
import { outlineFiles, readJson } from "./_content";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const lang = arg("--lang");
const write = process.argv.includes("--write");
if (!lang) throw new Error("用法:npm run content:dedupe -- --lang de [--write]");

type OLesson = { id: string; order: number; newItems: Item[]; reviewItems: string[] };
type OFile = { path: string; data: { lessons: OLesson[] } };

const files: OFile[] = outlineFiles(lang).map((path) => ({ path, data: readJson(path) }));
const all = files.flatMap((f) => f.data.lessons);
const ord = (l: OLesson) => orderFromId(l.id) ?? l.order;
all.sort((a, b) => ord(a) - ord(b));

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[.,!?¿¡;:"'’«»()…]/g, "").replace(/\s+/g, " ").trim();
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
const report: string[] = [];
const thin: string[] = [];

for (const l of all) {
  const keep: Item[] = [];
  for (const it of l.newItems) {
    const key = `${it.pos}:${norm(it.text)}`;
    const sameId = firstById.get(it.id);
    const sameText = (firstByText.get(key) ?? []).find((o) => sameSense(o, it));
    const original = sameId ?? sameText;
    if (original) {
      if (original.id !== it.id) remap.set(it.id, original.id);
      if (!l.reviewItems.includes(original.id)) l.reviewItems.push(original.id);
      report.push(`${l.id}: 去掉重复的 ${it.id}(${it.text}),改为复习 ${original.id}`);
      continue;
    }
    keep.push(it);
    firstById.set(it.id, it);
    firstByText.set(key, [...(firstByText.get(key) ?? []), it]);
  }
  l.newItems = keep;
  if (keep.length < 3) thin.push(`${l.id} 去重后只剩 ${keep.length} 个新词,需要补词`);
}
// 其他课里引用了被去掉的 id → 改成原来的 id
for (const l of all) {
  l.reviewItems = [...new Set(l.reviewItems.map((id) => remap.get(id) ?? id))].filter((id) => !l.newItems.some((n) => n.id === id));
}

console.log(report.length ? report.join("\n") : "没有重复的词");
if (thin.length) console.log(`\n注意:\n${thin.join("\n")}`);
if (write && report.length) {
  for (const f of files) {
    const before = readFileSync(f.path, "utf8");
    const after = `${JSON.stringify(f.data, null, 2)}\n`;
    if (after !== before) writeFileSync(f.path, after);
  }
  console.log(`\n已写回 ${files.length} 个大纲文件`);
}
