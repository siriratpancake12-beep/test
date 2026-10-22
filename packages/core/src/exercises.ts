import { cardKey, retrievability, type Direction } from "./srs";
import { rng, shuffle } from "./random";
import { splitArticle } from "./grading";
import type { Item, LanguagePack, Lesson, Line } from "./schema";
import type { IssueKind, Progress } from "./session";

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

/** 产出方向的题型:不指定时,有冠词的名词一半概率考冠词 */
type ProduceForm = "article" | "type";

export function exerciseFor(item: Item, direction: Direction, pool: Item[], pack: LanguagePack, seed: number, form?: ProduceForm): Exercise {
  const rand = rng(seed);
  if (direction === "recognize") return { type: "choose-meaning", itemId: item.id, direction, prompt: item.text, ...choice(item, pool, rand) };
  if (direction === "listen") return { type: "listen-choose", itemId: item.id, direction, say: item.text, ...choice(item, pool, rand) };

  // 产出方向:有冠词的名词,一半概率考冠词(中国学习者最容易错的点)
  const split = item.pos === "noun" && pack.articles ? splitArticle(item.text, pack) : null;
  // 选项总是按语言包里的固定顺序(der / die / das),学习者习惯这个顺序;正确答案的位置因此也不固定
  const arts = pack.articles ? Object.keys(pack.articles).filter((a) => !a.endsWith("'") && pack.articles![a] !== "pl") : [];
  const answer = split ? arts.indexOf(split[0].toLowerCase()) : -1;
  if (split && answer >= 0 && form !== "type" && (form === "article" || rand() < 0.5)) {
    return { type: "choose-article", itemId: item.id, direction, noun: split[1], zh: item.zh, options: arts, answer };
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

/** 课后练习最多穿插几个旧词 */
const REVIEW_IN_PRACTICE = 3;

/**
 * 一节课结尾的综合练习:先看懂(选意思/听力)→ 穿插复习前面课的旧词 → 产出(写/选冠词)→ 组句 → 开口说。
 * 旧词夹在新词中间练(交错练习),比把新词一口气练完、旧词另外复习记得更牢。
 */
export function lessonPractice(lesson: Lesson, pool: Item[], pack: LanguagePack, seed = 1): Exercise[] {
  const rand = rng(seed);
  const all = [...new Map([...pool, ...lesson.newItems].map((i) => [i.id, i])).values()];
  const byId = new Map(all.map((i) => [i.id, i]));
  const out: Exercise[] = [];
  lesson.newItems.forEach((it, i) => out.push(exerciseFor(it, i % 2 ? "listen" : "recognize", all, pack, seed + i)));
  lesson.reviewItems
    .map((id) => byId.get(id))
    .filter((it): it is Item => !!it)
    .slice(0, REVIEW_IN_PRACTICE)
    .forEach((it, i) => out.push(exerciseFor(it, i % 2 ? "listen" : "produce", all, pack, seed + 200 + i)));
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

const hasDiacritics = (s: string) => /ß/.test(s) || s.normalize("NFD") !== s;

/** 每种弱点练哪些词、用什么题型 */
const DRILL: Record<IssueKind, { pick: (it: Item, pack: LanguagePack) => boolean; form: ProduceForm }> = {
  article: { pick: (it, pack) => it.pos === "noun" && !!splitArticle(it.text, pack), form: "article" },
  accent: { pick: (it) => hasDiacritics(it.text), form: "type" },
  "umlaut-fallback": { pick: (it) => hasDiacritics(it.text), form: "type" },
  case: { pick: (it) => it.pos === "noun", form: "type" },
  typo: { pick: (it) => it.text.length >= 6, form: "type" },
  reading: { pick: (it) => !!it.features.reading, form: "type" },
};

/**
 * 弱点专练:针对学习者最近反复犯的错,挑学过的、相关的词,记得最差的排前面。
 * 例:德语冠词老错 → 专做"选 der/die/das";法语老漏重音符号 → 专写带重音的词。
 * 相关的词不到 3 个就不出(练不起来)。
 */
export function weaknessDrill(kind: IssueKind, p: Progress, pool: Item[], pack: LanguagePack, now: Date, seed = 1, n = 8): Exercise[] {
  const rule = DRILL[kind];
  const learned = pool.filter((it) => p.cards[cardKey(it.id, "produce")] && rule.pick(it, pack));
  if (learned.length < 3) return [];
  const memory = (it: Item) => retrievability(p.cards[cardKey(it.id, "produce")]!, now);
  return [...learned]
    .sort((a, b) => memory(a) - memory(b))
    .slice(0, n)
    .map((it, i) => exerciseFor(it, "produce", pool, pack, seed + i, rule.form));
}
