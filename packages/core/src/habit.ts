import type { DayLog, Progress } from "./session";
import { addDays, daysBetween, todayOf } from "./time";

/**
 * 学习习惯:连续天数、保护卡、每日目标。
 *
 * 设计原则:连续天数是为了帮人养成习惯,不是为了惩罚。
 * - 每连续学满 7 天送 1 张保护卡(最多存 2 张),漏学一两天自动用掉,连续天数不断。
 * - 漏太多天(保护卡不够)就从头算,但不扣任何东西;回来后有"轻松回归"计划(plan.ts)。
 */
export const MAX_FREEZES = 2;

/** 学完一课,或答了至少 5 道题,当天才算"学过"。 */
export const isActiveDay = (d?: DayLog) => !!d && (d.lessons.length > 0 || d.answers >= 5);

const counts = (p: Progress, day: string) => isActiveDay(p.log[day]) || p.frozenDays.includes(day);

/** 连续学习天数(到今天;今天还没学就到昨天)。用保护卡保住的天不计数,但不打断。 */
export function streak(p: Progress, now: Date): number {
  const today = todayOf(p, now);
  let d = counts(p, today) ? today : addDays(today, -1);
  let n = 0;
  while (counts(p, d)) {
    if (isActiveDay(p.log[d])) n++;
    d = addDays(d, -1);
  }
  return n;
}

/** 最近一次学过(或用保护卡保住)的日子,不含今天。 */
export function lastCountedDay(p: Progress, now: Date): string | null {
  const today = todayOf(p, now);
  const days = [...Object.keys(p.log).filter((k) => isActiveDay(p.log[k])), ...p.frozenDays].filter((d) => d < today);
  return days.length ? days.sort().at(-1)! : null;
}

/**
 * 结算漏学的天:从上次学习到昨天之间空了几天,保护卡够用就全部补上,不够就一张也不用
 * (反正连续天数要断了,留着卡下次用)。可以重复调用。
 */
export function settleFreezes(p: Progress, now: Date): Progress {
  const last = lastCountedDay(p, now);
  if (!last || p.freezes <= 0) return p;
  const yesterday = addDays(todayOf(p, now), -1);
  const gap = daysBetween(last, yesterday);
  if (gap <= 0 || gap > p.freezes) return p;
  const days = Array.from({ length: gap }, (_, i) => addDays(last, i + 1));
  return { ...p, freezes: p.freezes - gap, frozenDays: [...p.frozenDays, ...days] };
}

/** 当天第一次"学过"时检查:连续满 7 的倍数天,送一张保护卡。 */
export function afterActivity(prev: Progress, next: Progress, now: Date): Progress {
  const k = todayOf(next, now);
  if (isActiveDay(prev.log[k]) || !isActiveDay(next.log[k])) return next;
  const s = streak(next, now);
  return s > 0 && s % 7 === 0 && next.freezes < MAX_FREEZES ? { ...next, freezes: next.freezes + 1 } : next;
}

export function todayMinutes(p: Progress, now: Date): number {
  return Math.round((p.log[todayOf(p, now)]?.seconds ?? 0) / 60);
}

export function goalMet(p: Progress, now: Date): boolean {
  return todayMinutes(p, now) >= (p.goal?.dailyMinutes ?? 10);
}
