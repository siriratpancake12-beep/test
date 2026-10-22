import type { Issue, Verdict } from "./grading";
import type { Goal } from "./goal";
import { afterActivity, settleFreezes } from "./habit";
import type { Lesson } from "./schema";
import { DIRECTIONS, cardKey, dueCards, isNew, newCardState, reviewCard, type CardState, type Direction } from "./srs";
import { DEFAULT_TZ, localHour, todayOf } from "./time";

/**
 * 学习进度:学过哪些课、每张卡的状态、每天学了多少、常犯什么错。
 * 纯数据,App 负责存(SQLite),服务器负责同步。所有日期都是学习者的当地日期(见 time.ts)。
 */
export type Skill4 = "read" | "listen" | "write" | "speak";
export const SKILLS: Skill4[] = ["listen", "speak", "read", "write"];
export const SKILL_OF: Record<Direction, Skill4> = { recognize: "read", listen: "listen", produce: "write" };
export type IssueKind = Issue["kind"];

export interface DayLog {
  /** 有效学习秒数 */
  seconds: number;
  answers: number;
  /** 得分合计:对 1、基本对 0.75、错 0 */
  score: number;
  /** 当天新学的词条数 */
  newItems: number;
  /** 当天答的复习题数(不含新卡) */
  reviews: number;
  /** 当天做完的弱点专练次数 */
  drills: number;
  /** 当天做完的复习次数 */
  reviewSessions: number;
  /** 当天学完的课 */
  lessons: string[];
  /** 当天各类错误次数(周报对比用) */
  issues: Partial<Record<IssueKind, number>>;
}

/** 弱点权重:每犯一次 +1,按 7 天半衰期衰减,改掉了就自然消失 */
export interface IssueStat { weight: number; at: string }

export interface Progress {
  version: 2;
  lang: string;
  /** 当地时区偏移(分钟) */
  tz: number;
  goal: Goal | null;
  /** 课 id → 学完的日期 */
  completed: Record<string, string>;
  /** 分级测试跳过的课 */
  skipped: string[];
  /**
   * 免费体验的单元:每个人免费学"自己起步的那个单元"(零基础是第一单元,测试跳级的是跳到的单元)。
   * 第一次确定后不再变。null = 还没确定,按课程第一单元算。
   */
  freeUnit: string | null;
  /** 学过的词条 → 第一次学完(或测试跳过)的日期。"学了多少词"以这里为准 */
  learned: Record<string, string>;
  cards: Record<string, CardState>;
  log: Record<string, DayLog>;
  /** 各技能最近的得分(最多 50 个),用来估计能力和调节难度 */
  recent: Record<Skill4, number[]>;
  issues: Partial<Record<IssueKind, IssueStat>>;
  /** 连续天数保护卡(漏学一天自动用掉一张) */
  freezes: number;
  frozenDays: string[];
  /** 各小时学习次数,用来在学习者习惯的时间提醒 */
  hours: number[];
  checkpoints: { lessonId: string; day: string; score: number }[];
}

const RECENT_MAX = 50;
/** 一道题最多算 60 秒、一段阅读最多算 30 分钟,防止挂机把时长算多 */
const MAX_ANSWER_SEC = 60;
const MAX_BLOCK_SEC = 1800;

export const SCORE: Record<Verdict, number> = { correct: 1, almost: 0.75, wrong: 0 };

export const emptyDay = (): DayLog => ({ seconds: 0, answers: 0, score: 0, newItems: 0, reviews: 0, drills: 0, reviewSessions: 0, lessons: [], issues: {} });

export const emptyProgress = (lang: string, tz = DEFAULT_TZ): Progress => ({
  version: 2,
  lang,
  tz,
  goal: null,
  completed: {},
  skipped: [],
  freeUnit: null,
  learned: {},
  cards: {},
  log: {},
  recent: { read: [], listen: [], write: [], speak: [] },
  issues: {},
  freezes: 0,
  frozenDays: [],
  hours: Array(24).fill(0),
  checkpoints: [],
});

/** 读存档:补上新版本加的字段,兼容第一版(completedLessons / activeDays)。 */
export function normalizeProgress(raw: Record<string, unknown> & { lang: string }): Progress {
  const base = emptyProgress(raw.lang, typeof raw.tz === "number" ? raw.tz : DEFAULT_TZ);
  const p = { ...base, ...raw, version: 2 } as Progress & { completedLessons?: string[]; activeDays?: string[] };
  if (Array.isArray(p.completedLessons)) {
    const fallback = p.activeDays?.at(-1) ?? "1970-01-01";
    p.completed = Object.fromEntries(p.completedLessons.map((id) => [id, fallback]));
  }
  if (Array.isArray(p.activeDays)) {
    // 第一版只记了哪天学过:按"学完一课"补一条日志,连续天数不丢
    p.log = Object.fromEntries(p.activeDays.map((d) => [d, { ...emptyDay(), answers: 5 }]));
  }
  delete p.completedLessons;
  delete p.activeDays;
  p.recent = { ...base.recent, ...p.recent };
  return p;
}

export const isDone = (p: Progress, lessonId: string) => lessonId in p.completed || p.skipped.includes(lessonId);

const byOrder = (lessons: Lesson[]) => [...lessons].sort((a, b) => a.order - b.order);

/** 下一节该学的课:按顺序第一节没学完(也没跳过)的。 */
export function nextLesson(lessons: Lesson[], p: Progress): Lesson | undefined {
  return byOrder(lessons).find((l) => !isDone(p, l.id));
}

/** 课程解锁:学完前一节才能学下一节(可以用分级测试跳过)。 */
export function isUnlocked(lessons: Lesson[], p: Progress, lessonId: string): boolean {
  const sorted = byOrder(lessons);
  const i = sorted.findIndex((l) => l.id === lessonId);
  return i <= 0 || isDone(p, sorted[i - 1]!.id);
}

/** 改当天的日志。先结算漏学的天(用保护卡),再记这次学习,最后看看是否奖励保护卡。 */
function touchDay(p: Progress, now: Date, fn: (d: DayLog) => DayLog): Progress {
  const settled = settleFreezes(p, now);
  const k = todayOf(settled, now);
  const before = settled.log[k] ?? emptyDay();
  const after = fn({ ...before, lessons: [...before.lessons], issues: { ...before.issues } });
  return afterActivity(settled, { ...settled, log: { ...settled.log, [k]: after } }, now);
}

/**
 * 学完一节课:建卡(三个方向)、记日志。重复学不会重复建卡,也不会重复计"新学的词"。
 * (课里的练习会先给词条建卡,所以"是不是新词"要看 learned,不能看有没有卡。)
 */
export function completeLesson(p: Progress, lesson: Lesson, now: Date): Progress {
  const day = todayOf(p, now);
  const cards = { ...p.cards };
  const learned = { ...p.learned };
  let fresh = 0;
  for (const it of lesson.newItems) {
    if (!learned[it.id]) {
      learned[it.id] = day;
      fresh++;
    }
    for (const d of DIRECTIONS) {
      const k = cardKey(it.id, d);
      if (!cards[k]) cards[k] = newCardState(it.id, d, now);
    }
  }
  const completed = lesson.id in p.completed ? p.completed : { ...p.completed, [lesson.id]: day };
  return touchDay({ ...p, cards, learned, completed }, now, (d) => ({
    ...d,
    newItems: d.newItems + fresh,
    lessons: d.lessons.includes(lesson.id) ? d.lessons : [...d.lessons, lesson.id],
  }));
}

export interface Answer {
  /** 针对某个词条的题;句子排序、跟读等没有 */
  itemId?: string;
  direction?: Direction;
  /** 不填就按 direction 推出来 */
  skill?: Skill4;
  verdict: Verdict;
  ms?: number;
  issues?: Issue[];
}

/** 记一次答题:更新复习卡、技能得分、弱点、当天日志。 */
export function recordAnswer(p: Progress, a: Answer, now: Date): Progress {
  let cards = p.cards;
  let wasReview = false;
  if (a.itemId && a.direction) {
    const k = cardKey(a.itemId, a.direction);
    const cur = p.cards[k] ?? newCardState(a.itemId, a.direction, now);
    wasReview = !isNew(cur);
    cards = { ...cards, [k]: reviewCard(cur, a.verdict, now, a.ms) };
  }
  const score = SCORE[a.verdict];
  const skill = a.skill ?? (a.direction ? SKILL_OF[a.direction] : undefined);
  const recent = skill ? { ...p.recent, [skill]: [...p.recent[skill], score].slice(-RECENT_MAX) } : p.recent;

  const issues = { ...p.issues };
  for (const is of a.issues ?? []) {
    const prev = issues[is.kind];
    issues[is.kind] = { weight: (prev ? decayedWeight(prev, now) : 0) + 1, at: now.toISOString() };
  }
  const hours = [...p.hours];
  const h = localHour(now, p.tz);
  hours[h] = (hours[h] ?? 0) + 1;

  return touchDay({ ...p, cards, recent, issues, hours }, now, (d) => {
    for (const is of a.issues ?? []) d.issues[is.kind] = (d.issues[is.kind] ?? 0) + 1;
    return {
      ...d,
      seconds: d.seconds + Math.min((a.ms ?? 0) / 1000, MAX_ANSWER_SEC),
      answers: d.answers + 1,
      score: d.score + score,
      reviews: d.reviews + (wasReview ? 1 : 0),
    };
  });
}

/** 看对话、读语法这类不答题的学习时间。 */
export function addStudyTime(p: Progress, now: Date, seconds: number): Progress {
  return touchDay(p, now, (d) => ({ ...d, seconds: d.seconds + Math.max(0, Math.min(seconds, MAX_BLOCK_SEC)) }));
}

export function finishDrill(p: Progress, now: Date): Progress {
  return touchDay(p, now, (d) => ({ ...d, drills: d.drills + 1 }));
}

export function finishReview(p: Progress, now: Date): Progress {
  return touchDay(p, now, (d) => ({ ...d, reviewSessions: d.reviewSessions + 1 }));
}

export function recordCheckpoint(p: Progress, lessonId: string, score: number, now: Date): Progress {
  return { ...p, checkpoints: [...p.checkpoints, { lessonId, day: todayOf(p, now), score }] };
}

export function decayedWeight(s: IssueStat, now: Date): number {
  const days = (now.getTime() - Date.parse(s.at)) / 86_400_000;
  return s.weight * 0.5 ** (Math.max(0, days) / 7);
}

/**
 * 今天的复习:到期的卡 + 刚学完还没复习过的新卡(新卡不超过 newLimit 张)。
 * 复习量封顶,避免攒了几天后一次几百张把人吓跑。
 */
export function todaysReview(p: Progress, now: Date, limit = 30, newLimit = 10): CardState[] {
  const all = Object.values(p.cards);
  const due = dueCards(all, now, limit);
  const fresh = all.filter(isNew).slice(0, Math.max(0, Math.min(newLimit, limit - due.length)));
  return [...due, ...fresh];
}

export const setGoal = (p: Progress, goal: Goal): Progress => ({ ...p, goal });
