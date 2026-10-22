import type { Direction } from "./srs";
import { rng, shuffle } from "./random";
import { splitArticle } from "./grading";
import type { Item, LanguagePack, Lesson, Line } from "./schema";

/**
 * 从课程内容自动生成练习。题型多样是参考项目的短板(几乎全是"听音选图"),
 * 这里每个方向至少两种题,并加入语种专属题型(德法西的冠词、句子排序)。
 */
export type Exercise =
  | { type: "choose-meaning"; itemId: string; direction: "recognize"; prompt: string; options: string[]; answer: number }
  | { type: "listen-choose"; itemId: string; direction: "listen"; say: string; options: string[]; answer: number }
  | { type: "type-target"; itemId: string; direction: "produce"; promptZh: string; hint?: string }
  | { type: "choose-article"; itemId: string; direction: "produce"; noun: string; zh: string; options: string[]; answer: number }
  | { type: "reorder"; lineText: string; zh: string; tiles: string[]; answer: string[] }
  | { type: "speak"; text: string; zh: string };

const OPTIONS = 4;

/** 选干扰项:优先同词性(名词配名词),意思不能重复。 */
function distractors(target: Item, pool: Item[], rand: () => number, n: number): Item[] {
  const others = pool.filter((p) => p.id !== target.id && p.zh !== target.zh);
  const same = shuffle(others.filter((p) => p.pos === target.pos), rand);
  const rest = shuffle(others.filter((p) => p.pos !== target.pos), rand);
  // 同一个意思只出现一次(词库里可能有同义词条)
  const seen = new Set<string>();
  return [...same, ...rest].filter((p) => !seen.has(p.zh) && !!seen.add(p.zh)).slice(0, n);
}

function choice(target: Item, pool: Item[], rand: () => number): { options: string[]; answer: number } {
  const opts = shuffle([target, ...distractors(target, pool, rand, OPTIONS - 1)], rand);
  return { options: opts.map((o) => o.zh), answer: opts.findIndex((o) => o.id === target.id) };
}

export function exerciseFor(item: Item, direction: Direction, pool: Item[], pack: LanguagePack, seed: number): Exercise {
  const rand = rng(seed);
  if (direction === "recognize") return { type: "choose-meaning", itemId: item.id, direction, prompt: item.text, ...choice(item, pool, rand) };
  if (direction === "listen") return { type: "listen-choose", itemId: item.id, direction, say: item.text, ...choice(item, pool, rand) };

  // 产出方向:有冠词的名词,一半概率考冠词(中国学习者最容易错的点)
  const split = item.pos === "noun" && pack.articles ? splitArticle(item.text, pack) : null;
  if (split && rand() < 0.5) {
    const arts = Object.keys(pack.articles!).filter((a) => !a.endsWith("'") && pack.articles![a] !== "pl");
    const options = Array.from(new Set([split[0], ...arts]));
    return { type: "choose-article", itemId: item.id, direction, noun: split[1], zh: item.zh, options, answer: options.indexOf(split[0]) };
  }
  const hint = item.features.roman ?? undefined;
  return { type: "type-target", itemId: item.id, direction, promptZh: item.zh, ...(hint ? { hint } : {}) };
}

/** 按空格切句子(日语没有空格,按词条切;这里先支持有空格的语言)。 */
export function tokens(line: Line, pack: LanguagePack): string[] | null {
  if (pack.code === "ja") return null;
  const t = line.text.split(/\s+/).filter(Boolean);
  return t.length >= 3 && t.length <= 10 ? t : null;
}

/** 一节课结尾的综合练习:先看懂(选意思/听力)→ 再产出(写/选冠词)→ 再组句 → 最后开口说。 */
export function lessonPractice(lesson: Lesson, pool: Item[], pack: LanguagePack, seed = 1): Exercise[] {
  const rand = rng(seed);
  const all = [...new Map([...pool, ...lesson.newItems].map((i) => [i.id, i])).values()];
  const out: Exercise[] = [];
  lesson.newItems.forEach((it, i) => out.push(exerciseFor(it, i % 2 ? "listen" : "recognize", all, pack, seed + i)));
  lesson.newItems.forEach((it, i) => out.push(exerciseFor(it, "produce", all, pack, seed + 100 + i)));
  for (const line of shuffle(lesson.lines, rand).slice(0, 2)) {
    const t = tokens(line, pack);
    if (t) out.push({ type: "reorder", lineText: line.text, zh: line.zh, tiles: shuffle(t, rand), answer: t });
  }
  const speakLine = lesson.lines.find((l) => l.text.length <= 60);
  if (speakLine) out.push({ type: "speak", text: speakLine.text, zh: speakLine.zh });
  return out;
}

/** 排序题判分:按词比较,忽略大小写和句末标点。 */
export function checkReorder(answer: string[], picked: string[]): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[.,!?¿¡]/g, "");
  return answer.length === picked.length && answer.every((w, i) => n(w) === n(picked[i]!));
}
