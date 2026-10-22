import { isActiveDay } from "./habit";
import { decayedWeight, SKILLS, type IssueKind, type Progress, type Skill4 } from "./session";
import { State } from "ts-fsrs";
import { retrievability, type CardState } from "./srs";
import { lastDays, todayOf } from "./time";

/**
 * 学习者画像:会了多少、哪方面弱、难度合不合适、有没有流失的苗头。
 * 这些数字直接驱动每日计划(plan.ts)、周报(report.ts)和提醒。
 */

/** 学过(建过卡)的词条 */
export function introducedItems(p: Progress): Set<string> {
  return new Set(Object.values(p.cards).map((c) => c.itemId));
}

/**
 * 记牢的卡:已经进入长期复习(不是刚学、也不是刚答错在重学),而且现在还记得(记忆概率 ≥ 85%)。
 * 只看记忆概率不行:任何卡刚答完(哪怕答错)记忆概率都接近 100%。
 */
const solid = (c: CardState, now: Date, threshold: number) => c.card.state === State.Review && retrievability(c, now) >= threshold;

/**
 * "能主动用的词":看到中文能写出/说出外语,而且已经记牢。
 * 这是比"学过多少词"更诚实的指标,周报里给学习者看的就是它。
 */
export function activeVocab(p: Progress, now: Date, threshold = 0.85): number {
  return Object.values(p.cards).filter((c) => c.direction === "produce" && solid(c, now, threshold)).length;
}

/** 认得的词(看到外语知道意思) */
export function passiveVocab(p: Progress, now: Date, threshold = 0.85): number {
  return Object.values(p.cards).filter((c) => c.direction === "recognize" && solid(c, now, threshold)).length;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** 听说读写各自最近的正确率;样本太少(< 5)返回 null,界面上显示"还在了解你"。 */
export function skillScores(p: Progress): Record<Skill4, number | null> {
  return Object.fromEntries(SKILLS.map((s) => [s, p.recent[s].length >= 5 ? mean(p.recent[s]) : null])) as Record<Skill4, number | null>;
}

export interface Weakness { kind: IssueKind; weight: number }

/** 现在最该练的弱点(权重 ≥ 2,即最近一周内反复出现),从重到轻。 */
export function weaknesses(p: Progress, now: Date): Weakness[] {
  return (Object.entries(p.issues) as [IssueKind, NonNullable<Progress["issues"][IssueKind]>][])
    .map(([kind, st]) => ({ kind, weight: decayedWeight(st, now) }))
    .filter((w) => w.weight >= 2)
    .sort((a, b) => b.weight - a.weight);
}

export const topWeakness = (p: Progress, now: Date): Weakness | undefined => weaknesses(p, now)[0];

/**
 * 难度调节。学习效果最好的区间是"大部分会、少部分要想一想",正确率 75%–93%。
 * - 太高(> 93%):内容太简单,学习者会觉得没意思 → 加快、建议跳级测试
 * - 太低(< 75%):太难,会挫败放弃 → 放慢、多复习
 */
export type Pace = "faster" | "steady" | "slower";
export function pace(p: Progress): Pace {
  const all = [...p.recent.read, ...p.recent.listen, ...p.recent.write];
  if (all.length < 30) return "steady";
  const m = mean(all);
  return m > 0.93 ? "faster" : m < 0.75 ? "slower" : "steady";
}

export interface Engagement {
  /** 离上次学习过去几天(今天学了 = 0) */
  daysAway: number;
  minutes7: number;
  minutesPrev7: number;
  activeDays14: number;
  risk: "low" | "medium" | "high";
}

/**
 * 流失风险。续订最大的敌人是"不知不觉不学了":先是一周学得比上周少很多,然后几天不打开。
 * 风险高时:计划自动变轻、提醒换成鼓励回来的话(不制造焦虑)。
 */
export function engagement(p: Progress, now: Date): Engagement {
  const today = todayOf(p, now);
  const days = lastDays(today, 14);
  const mins = (ds: string[]) => Math.round(ds.reduce((a, d) => a + (p.log[d]?.seconds ?? 0), 0) / 60);
  const firstActive = days.findIndex((d) => isActiveDay(p.log[d]));
  const known = Object.keys(p.log).some((d) => isActiveDay(p.log[d]));
  const daysAway = firstActive >= 0 ? firstActive : known ? 14 : 0;
  const minutes7 = mins(days.slice(0, 7));
  const minutesPrev7 = mins(days.slice(7));
  const activeDays14 = days.filter((d) => isActiveDay(p.log[d])).length;
  const dropping = minutesPrev7 >= 30 && minutes7 < minutesPrev7 * 0.4;
  const risk = daysAway >= 5 ? "high" : daysAway >= 2 || dropping ? "medium" : "low";
  return { daysAway, minutes7, minutesPrev7, activeDays14, risk };
}

/** 学习者习惯在几点学(提醒用)。没有记录时默认晚上 8 点。 */
export function usualHour(p: Progress): number {
  const max = Math.max(...p.hours);
  return max > 0 ? p.hours.indexOf(max) : 20;
}
