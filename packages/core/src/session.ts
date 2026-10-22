import { DIRECTIONS, cardKey, dueCards, isNew, newCardState, reviewCard, type CardState } from "./srs";
import type { Verdict } from "./grading";
import type { Lesson } from "./schema";

/**
 * 学习进度:哪些课学完了、每张卡的状态。纯数据,App 负责存(SQLite),服务器负责同步。
 */
export interface Progress {
  lang: string;
  completedLessons: string[];
  cards: Record<string, CardState>;
  /** 连续学习天数用:YYYY-MM-DD */
  activeDays: string[];
}

export const emptyProgress = (lang: string): Progress => ({ lang, completedLessons: [], cards: {}, activeDays: [] });

/** 下一节该学的课:按顺序第一节没学完的。 */
export function nextLesson(lessons: Lesson[], p: Progress): Lesson | undefined {
  return [...lessons].sort((a, b) => a.order - b.order).find((l) => !p.completedLessons.includes(l.id));
}

/** 课程解锁:学完前一节才能学下一节(可以用分级测试跳过)。 */
export function isUnlocked(lessons: Lesson[], p: Progress, lessonId: string): boolean {
  const sorted = [...lessons].sort((a, b) => a.order - b.order);
  const i = sorted.findIndex((l) => l.id === lessonId);
  return i <= 0 || p.completedLessons.includes(sorted[i - 1]!.id);
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** 学完一节课:建卡(三个方向)、记当天活跃。 */
export function completeLesson(p: Progress, lesson: Lesson, now: Date): Progress {
  const cards = { ...p.cards };
  for (const it of lesson.newItems) {
    for (const d of DIRECTIONS) {
      const k = cardKey(it.id, d);
      if (!cards[k]) cards[k] = newCardState(it.id, d, now);
    }
  }
  return {
    ...p,
    completedLessons: p.completedLessons.includes(lesson.id) ? p.completedLessons : [...p.completedLessons, lesson.id],
    cards,
    activeDays: markActive(p.activeDays, now),
  };
}

function markActive(days: string[], now: Date): string[] {
  const k = dayKey(now);
  return days.includes(k) ? days : [...days, k];
}

/** 记一次答题。新卡第一次答也走这里(变成学习中)。 */
export function recordAnswer(p: Progress, itemId: string, direction: CardState["direction"], verdict: Verdict, now: Date, ms?: number): Progress {
  const k = cardKey(itemId, direction);
  const cur = p.cards[k] ?? newCardState(itemId, direction, now);
  return { ...p, cards: { ...p.cards, [k]: reviewCard(cur, verdict, now, ms) }, activeDays: markActive(p.activeDays, now) };
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

/** 连续学习天数(到今天或昨天为止)。 */
export function streak(p: Progress, now: Date): number {
  const set = new Set(p.activeDays);
  const d = new Date(now);
  if (!set.has(dayKey(d))) d.setUTCDate(d.getUTCDate() - 1);
  let n = 0;
  while (set.has(dayKey(d))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}
