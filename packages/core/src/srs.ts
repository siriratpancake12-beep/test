import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from "ts-fsrs";
import type { Verdict } from "./grading";

/**
 * 间隔复习(FSRS)。
 *
 * 一个词条拆成三张卡,分别记忆:
 * - recognize:看到外语 → 想起中文意思(最容易)
 * - listen   :听到外语 → 想起意思
 * - produce  :看到中文 → 写出/说出外语(最难,决定能不能真正用出来)
 * 参考项目一个语块只有一张卡,会出现"认得但说不出"的情况。
 */
export type Direction = "recognize" | "listen" | "produce";
export const DIRECTIONS: Direction[] = ["recognize", "listen", "produce"];

export interface CardState {
  itemId: string;
  direction: Direction;
  card: Card;
}

export const cardKey = (itemId: string, direction: Direction) => `${itemId}#${direction}`;

const scheduler = fsrs(generatorParameters({ enable_fuzz: false, request_retention: 0.9 }));

export function newCardState(itemId: string, direction: Direction, now: Date): CardState {
  return { itemId, direction, card: createEmptyCard(now) };
}

/**
 * 答题结果 → FSRS 评分。
 * almost 算"困难"而不是"错":意思会了,只是细节要再练,不应该把间隔打回原点。
 * 答得很快且正确 → easy。
 */
export function gradeFrom(verdict: Verdict, ms?: number): Grade {
  if (verdict === "wrong") return Rating.Again;
  if (verdict === "almost") return Rating.Hard;
  if (ms !== undefined && ms < 2500) return Rating.Easy;
  return Rating.Good;
}

export function reviewCard(s: CardState, verdict: Verdict, now: Date, ms?: number): CardState {
  return { ...s, card: scheduler.next(s.card, now, gradeFrom(verdict, ms)).card };
}

export const isDue = (s: CardState, now: Date) => s.card.due.getTime() <= now.getTime();
export const isNew = (s: CardState) => s.card.state === State.New;

/** 到期的卡,最早到期的排前面;产出方向优先(更难、更值钱)。 */
export function dueCards(cards: CardState[], now: Date, limit: number): CardState[] {
  const w: Record<Direction, number> = { produce: 0, listen: 1, recognize: 2 };
  return cards
    .filter((c) => !isNew(c) && isDue(c, now))
    .sort((a, b) => a.card.due.getTime() - b.card.due.getTime() || w[a.direction] - w[b.direction])
    .slice(0, limit);
}

/** 某个词条"掌握"了:三个方向都已复习过且稳定度超过 21 天。 */
export function isMastered(cards: CardState[], itemId: string): boolean {
  const mine = cards.filter((c) => c.itemId === itemId);
  return mine.length === DIRECTIONS.length && mine.every((c) => !isNew(c) && c.card.stability >= 21);
}
