import { checkReorder, exerciseFor, tokens, type Exercise } from "./exercises";
import { CEFR_ORDER, type Goal } from "./goal";
import { splitArticle, type Verdict } from "./grading";
import { rng, shuffle } from "./random";
import type { Cefr, Item, LanguagePack, Lesson, Line } from "./schema";
import { isDone, SCORE, type Progress } from "./session";
import type { Direction } from "./srs";

/**
 * 单元练习、单元测评、单元证书,以及目标达成后的"下一个目标"。
 *
 * 学完一个单元:先做单元练习(约 25 题、10 分钟,不计分),把整个单元的词和句子混在一起再练一遍;
 * 再做单元测评(12–15 题:看懂、听懂、写出来/选冠词、句子排序),80 分通过,发一张能分享的证书:
 * "完成 A1-1 单元 · 92 分 · 这个单元学会了……"。阶段性的成绩让进步看得见;没通过就告诉他复习哪些词。
 * 练习和测评的作答都照常记进复习卡,答错的词很快会再出现。
 *
 * 测评成绩用 session.ts 的 recordCheckpoint 记,lessonId 记"测评时这个单元的最后一课"。
 * 课 id 永远不改,所以单元以后加了课、改了名字,旧成绩仍然对得上这个单元。
 */
export const CHECKPOINT_PASS = 80;
/** 单元测评 12–15 题,排序题最多 3 道 */
const TEST = { min: 12, max: 15, maxReorder: 3 };
/** 单元练习约 25 题(按每题 0.35 分钟算约 10 分钟,见 hours.ts),排序题多一些 */
const PRACTICE = { min: 20, max: 25, maxReorder: 5 };

export interface CourseUnit {
  unit: string;
  cefr: Cefr;
  /** 按课的顺序 */
  lessons: Lesson[];
}

/** 课程按单元分组(单元按第一课的顺序排)。 */
export function courseUnits(lessons: Lesson[]): CourseUnit[] {
  const out: CourseUnit[] = [];
  for (const l of [...lessons].sort((a, b) => a.order - b.order)) {
    const u = out.find((x) => x.unit === l.unit);
    if (u) u.lessons.push(l);
    else out.push({ unit: l.unit, cefr: l.cefr, lessons: [l] });
  }
  return out;
}

export const unitOfLesson = (lessons: Lesson[], lessonId: string | undefined): CourseUnit | undefined =>
  lessonId ? courseUnits(lessons).find((u) => u.lessons.some((l) => l.id === lessonId)) : undefined;

/** "A1-1 你好,我是……" → 编号 "A1-1" + 主题 "你好,我是……";没有编号的单元名整个当编号。 */
export function unitLabel(unit: string): { code: string; theme: string } {
  const m = /^(\S*\d\S*)\s+(.+)$/.exec(unit.trim());
  return m ? { code: m[1]!, theme: m[2]! } : { code: unit.trim(), theme: "" };
}

/** 记测评成绩用的 lessonId:这个单元现在的最后一课。 */
export const checkpointLessonId = (unitLessons: Lesson[]): string =>
  [...unitLessons].sort((a, b) => a.order - b.order).at(-1)?.id ?? "";

function uniqueBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(key(x)) && !!seen.add(key(x)));
}

/**
 * 名额分配:产出 40%(最能说明"会用")、听 30%、看 30%。同一方向不重复考同一个词,
 * 所以每个方向最多 n 题;词少时多出来的名额给还有词可考的方向。
 */
function splitQuota(total: number, n: number): Record<Direction, number> {
  const share: Record<Direction, number> = { produce: 0.4, listen: 0.3, recognize: 0.3 };
  const q: Record<Direction, number> = { produce: 0, listen: 0, recognize: 0 };
  const dirs = Object.keys(share) as Direction[];
  for (let k = 0; k < total; k++) {
    const d = dirs.filter((x) => q[x] < n).sort((a, b) => q[a] / share[a] - q[b] / share[b])[0];
    if (!d) break;
    q[d]++;
  }
  return q;
}

/** 和 exerciseFor 的规则一致:冠词在语言包的选项里(der/die/das、le/la),才出得了选冠词题。 */
function articleQuizzable(it: Item, pack: LanguagePack): boolean {
  const sp = it.pos === "noun" ? splitArticle(it.text, pack) : null;
  const art = sp?.[0].toLowerCase();
  return !!art && !art.endsWith("'") && !!pack.articles && art in pack.articles && pack.articles[art] !== "pl";
}

/** 打乱词块;碰巧还是原来的顺序就再打乱几次,不然这题等于白送。 */
function scramble(words: string[], rand: () => number): string[] {
  let t = shuffle(words, rand);
  for (let k = 0; k < 5 && checkReorder(words, t); k++) t = shuffle(words, rand);
  return t;
}

/**
 * 单元测评的题:从这个单元全部的词条和句子里出 12–15 题。
 * - 看懂(选意思)、听懂(听音选意思)、写出来(德法名词轮流考选冠词和写全)、句子排序都有;
 * - 同一个方向不重复考同一个词,尽量让更多的词被考到;
 * - 词条少的单元多出几道排序题凑够 12 题;材料实在太少(比如只有两三个词)就少出,不出重复的题。
 * 顺序先易后难:看懂、听懂 → 写出来 → 组句。同一个种子出同一套题。
 */
export function checkpointQuestions(unitLessons: Lesson[], pool: Item[], pack: LanguagePack, seed = 1): Exercise[] {
  return unitQuestions(unitLessons, pool, pack, seed, TEST);
}

/** 单元练习的题:和测评同样的出题规则,题多一些(约 25 题),不计分。 */
export function unitPracticeQuestions(unitLessons: Lesson[], pool: Item[], pack: LanguagePack, seed = 1): Exercise[] {
  return unitQuestions(unitLessons, pool, pack, seed, PRACTICE);
}

function unitQuestions(
  unitLessons: Lesson[], pool: Item[], pack: LanguagePack, seed: number,
  size: { min: number; max: number; maxReorder: number },
): Exercise[] {
  const rand = rng(seed);
  const lessons = [...unitLessons].sort((a, b) => a.order - b.order);
  const items = uniqueBy(lessons.flatMap((l) => l.newItems), (i) => i.id);
  // 干扰项从整门课的词里挑;本单元的词一定在里面
  const all = uniqueBy([...pool, ...items], (i) => i.id);
  const sentences = uniqueBy(lessons.flatMap((l) => l.lines), (l) => l.text)
    .map((line) => ({ line, words: tokens(line, pack) }))
    .filter((x): x is { line: Line; words: string[] } => !!x.words);

  const itemCap = items.length * 3;
  let nReorder = Math.min(size.maxReorder, sentences.length);
  if (nReorder + itemCap < size.min) nReorder = Math.min(sentences.length, size.min - itemCap);
  const quota = splitQuota(Math.min(size.max - nReorder, itemCap), items.length);

  // 先给产出题挑词,再听、再看;每次挑目前被考得最少的词(同样少的按打乱后的顺序)
  const order = shuffle(items, rand);
  const used = new Map<string, number>();
  const pick = (n: number) => {
    const chosen = [...order].sort((a, b) => (used.get(a.id) ?? 0) - (used.get(b.id) ?? 0)).slice(0, n);
    for (const it of chosen) used.set(it.id, (used.get(it.id) ?? 0) + 1);
    return chosen;
  };
  const produce = pick(quota.produce);
  const listen = pick(quota.listen);
  const recognize = pick(quota.recognize);

  // 有冠词的名词轮流考"选冠词"和"写全(连冠词)":两种都会才算真的记住了性别
  let nouns = 0;
  const form = (it: Item) => (articleQuizzable(it, pack) && nouns++ % 2 === 0 ? "article" : "type");

  const comprehension = shuffle(
    [
      ...recognize.map((it, i) => exerciseFor(it, "recognize", all, pack, seed + i)),
      ...listen.map((it, i) => exerciseFor(it, "listen", all, pack, seed + 50 + i)),
    ],
    rand,
  );
  const production = produce.map((it, i) => exerciseFor(it, "produce", all, pack, seed + 100 + i, form(it)));
  const reorder: Exercise[] = shuffle(sentences, rand)
    .slice(0, nReorder)
    .map(({ line, words }) => ({ type: "reorder", lineText: line.text, zh: line.zh, tiles: scramble(words, rand), answer: words }));
  return [...comprehension, ...production, ...reorder];
}

export interface CheckpointScore {
  /** 0–100:对 1 分、基本对 0.75 分(和复习的算法一样),折算后向下取整 */
  score: number;
  /** 答对(含基本对)的题数 */
  right: number;
  total: number;
  /** ≥ 80 分 */
  passed: boolean;
  /** 答错的词条 id(提示复习这些) */
  missedItems: string[];
  /** 排错的句子 */
  missedLines: string[];
}

/** 测评打分。verdicts 和题一一对应,没答的算错。 */
export function scoreCheckpoint(questions: Exercise[], verdicts: Verdict[]): CheckpointScore {
  let points = 0;
  let right = 0;
  const missedItems: string[] = [];
  const missedLines: string[] = [];
  questions.forEach((q, i) => {
    const v = verdicts[i] ?? "wrong";
    points += SCORE[v];
    if (v !== "wrong") right++;
    else if ("itemId" in q) {
      if (!missedItems.includes(q.itemId)) missedItems.push(q.itemId);
    } else if (q.type === "reorder") missedLines.push(q.lineText);
  });
  const total = questions.length;
  // 加一个极小量再取整:浮点误差不能把正好 80 分算成 79 分
  const score = total ? Math.floor((points * 100) / total + 1e-9) : 0;
  return { score, right, total, passed: score >= CHECKPOINT_PASS, missedItems, missedLines };
}

export interface UnitCheckpointStatus {
  /** 这个单元的课都学完了(分级测试跳过的也算),可以测评 */
  ready: boolean;
  passed: boolean;
  attempts: number;
  /** 最好的一次(同分取最早的那天) */
  best?: { score: number; day: string };
  /** 最近的一次 */
  last?: { score: number; day: string };
}

/** 一个单元的测评情况。成绩按"记录的课属于这个单元"来找(见文件开头的说明)。 */
export function unitCheckpoint(p: Progress, unitLessons: Lesson[]): UnitCheckpointStatus {
  const ids = new Set(unitLessons.map((l) => l.id));
  let best: UnitCheckpointStatus["best"];
  let last: UnitCheckpointStatus["last"];
  let attempts = 0;
  for (const c of p.checkpoints) {
    if (!ids.has(c.lessonId)) continue;
    attempts++;
    if (!best || c.score > best.score || (c.score === best.score && c.day < best.day)) best = { score: c.score, day: c.day };
    if (!last || c.day >= last.day) last = { score: c.score, day: c.day };
  }
  return {
    ready: unitLessons.length > 0 && unitLessons.every((l) => isDone(p, l.id)),
    passed: !!best && best.score >= CHECKPOINT_PASS,
    attempts,
    ...(best ? { best } : {}),
    ...(last ? { last } : {}),
  };
}

/**
 * 首页计划里要不要出现"单元测评":最近学完、还没通过测评的那个单元。
 * 课全部是分级测试跳过的单元不提示(测试已经证明会了),但想测也可以从学习计划页进去。
 */
export function pendingCheckpoint(p: Progress, lessons: Lesson[]): CourseUnit | undefined {
  return courseUnits(lessons)
    .filter((u) => {
      const st = unitCheckpoint(p, u.lessons);
      return st.ready && !st.passed && u.lessons.some((l) => l.id in p.completed);
    })
    .at(-1);
}

/**
 * 目标达成:目标等级(及以下)的课全部学完(分级测试跳过的也算),或者通过了目标等级最后一个单元的测评
 * (这样以后这个单元又加了课,已经通过的人也不会被"退回"未达成)。目标等级还没有课时不算达成。
 */
export function goalReached(p: Progress, lessons: Lesson[]): boolean {
  const target = p.goal?.target;
  if (!target) return false;
  const atTarget = lessons.filter((l) => l.cefr === target);
  if (!atTarget.length) return false;
  const upTo = CEFR_ORDER.indexOf(target);
  if (lessons.filter((l) => CEFR_ORDER.indexOf(l.cefr) <= upTo).every((l) => isDone(p, l.id))) return true;
  return unitCheckpoint(p, courseUnits(atTarget).at(-1)!.lessons).passed;
}

/** 各等级能做什么(和新用户引导里的说法一致) */
export const LEVEL_ZH: Record<Cefr, string> = {
  "pre-A1": "认识字母和发音,会几句最基本的问候",
  A1: "能应付最简单的交流:打招呼、点餐、问路",
  A2: "能处理旅行、购物等日常事务,聊熟悉的话题",
  B1: "能在国外独立生活学习,应付大部分日常情况",
  B2: "能流利讨论较复杂的话题,很多留学、移民项目要求这个水平",
  C1: "能在学习和工作中流利、准确地表达复杂的内容",
};

export interface NextGoal {
  goal: Goal;
  titleZh: string;
  subZh: string;
}

/**
 * 达到目标以后建议的下一个目标:往上一个等级,或者以考试为目标(语言包里的主流考试)。
 * "目标达成 = 不学了 = 退订"是续订最大的坑之一,所以在达成的那一刻就给出下一站。
 * 每天的时长保留;期限是为旧目标定的,去掉,由学习者重新定。已经是最高等级就不再建议。
 */
export function nextGoals(goal: Goal, pack: LanguagePack): NextGoal[] {
  const next = CEFR_ORDER[CEFR_ORDER.indexOf(goal.target) + 1];
  if (!next) return [];
  const { deadline: _d, exam: _e, ...base } = goal;
  const out: NextGoal[] = [
    {
      goal: { ...base, target: next, ...(goal.kind === "exam" && goal.exam ? { exam: goal.exam } : {}) },
      titleZh: `下一个等级:${next}`,
      subZh: LEVEL_ZH[next],
    },
  ];
  for (const exam of pack.examsZh.slice(0, 3)) {
    out.push({ goal: { ...base, kind: "exam", exam, target: next }, titleZh: `考试方向:${exam}`, subZh: `以考试为目标,先达到 ${next}` });
  }
  return out;
}
