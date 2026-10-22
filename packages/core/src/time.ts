/**
 * 日期都按学习者的当地时间算。用 UTC 算的话,北京时间早上 8 点前学的会记到前一天,
 * 连续天数会莫名其妙断掉。tz = 与 UTC 的偏移分钟数(北京时间 480)。
 */
const DAY_MS = 86_400_000;
export const DEFAULT_TZ = 480;

/** 当地日期 YYYY-MM-DD */
export function dayKey(d: Date, tz = DEFAULT_TZ): string {
  return new Date(d.getTime() + tz * 60_000).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** b 比 a 晚几天 */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** 当地时间的小时(0–23) */
export function localHour(d: Date, tz = DEFAULT_TZ): number {
  return new Date(d.getTime() + tz * 60_000).getUTCHours();
}

/** 当地某天某时刻 → Date */
export function atLocal(day: string, hour: number, minute: number, tz = DEFAULT_TZ): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute - tz) * 60_000);
}

/** 从 from 往前数 n 天(含 from)的日期列表,最近的在前 */
export function lastDays(from: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(from, -i));
}

/**
 * 学习者的"今天"。换了时区(比如从北京飞到柏林)后,以前按北京时间记的日子可能比当地的今天还晚一天,
 * 这时以记录里最晚的一天为准:不会把刚学过的那天当成"还没到",连续天数也不会莫名中断。
 */
export function todayOf(p: { tz: number; log: Record<string, unknown> }, now: Date): string {
  let today = dayKey(now, p.tz);
  for (const k of Object.keys(p.log)) if (k > today) today = k;
  return today;
}
