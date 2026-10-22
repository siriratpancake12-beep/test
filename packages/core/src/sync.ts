import type { DayLog, Progress } from "./session";
import type { CardState } from "./srs";

/**
 * 多台设备的进度合并(手机 + 平板、重装后、离线学了一阵再联网)。
 * 原则:不丢任何学习记录;同样的两份进度不管谁先谁后,合并结果一样;重复合并不改变结果。
 *
 * - 学过的课、学过的词、跳过的课:取并集(日期取更早的)
 * - 复习卡:取最后一次复习更晚的那张(两边都没复习过就取到期更早的)
 * - 每天的日志:每一项取较大值(同一天两台设备各学一部分时会少算,但绝不会重复算)
 * - 目标、时区等设置:取最近有学习活动的那份
 */
export function mergeProgress(a: Progress, b: Progress): Progress {
  if (a.lang !== b.lang) throw new Error("不同语种的进度不能合并");
  const [newer, older] = order(a, b);

  const cards: Record<string, CardState> = { ...older.cards };
  for (const [k, c] of Object.entries(newer.cards)) {
    const o = cards[k];
    cards[k] = !o ? c : pickCard(o, c);
  }

  const log: Record<string, DayLog> = { ...older.log };
  for (const [day, d] of Object.entries(newer.log)) log[day] = log[day] ? mergeDay(log[day]!, d) : d;

  const issues = { ...older.issues };
  for (const [k, st] of Object.entries(newer.issues) as [keyof Progress["issues"], NonNullable<Progress["issues"][keyof Progress["issues"]]>][]) {
    const o = issues[k];
    issues[k] = !o || st.at >= o.at ? st : o;
  }

  const checkpoints = [...older.checkpoints];
  for (const c of newer.checkpoints) {
    if (!checkpoints.some((x) => x.lessonId === c.lessonId && x.day === c.day && x.score === c.score)) checkpoints.push(c);
  }

  return {
    ...newer,
    completed: sortKeys(unionEarliest(older.completed, newer.completed)),
    learned: sortKeys(unionEarliest(older.learned, newer.learned)),
    skipped: [...new Set([...older.skipped, ...newer.skipped])].sort(),
    // 免费单元一旦确定不再变:取先确定的那份
    freeUnit: older.freeUnit ?? newer.freeUnit,
    cards: sortKeys(cards),
    log: sortKeys(log),
    issues: sortKeys(issues),
    frozenDays: [...new Set([...older.frozenDays, ...newer.frozenDays])].sort(),
    hours: newer.hours.map((h, i) => Math.max(h, older.hours[i] ?? 0)),
    checkpoints: checkpoints.sort((x, y) => (x.day + x.lessonId < y.day + y.lessonId ? -1 : 1)),
  };
}

const ms = (d: Date | string | undefined | null) => (d ? new Date(d).getTime() : 0);

/** 最近一次学习活动的时间:日志里最晚的一天,或最晚一次复习 */
function lastActivity(p: Progress): number {
  let t = 0;
  for (const day of Object.keys(p.log)) t = Math.max(t, Date.parse(`${day}T00:00:00Z`));
  for (const c of Object.values(p.cards)) t = Math.max(t, ms(c.card.last_review));
  return t;
}

/** 按最近活动排出"新、旧";完全一样时按内容排,保证结果和参数顺序无关 */
function order(a: Progress, b: Progress): [Progress, Progress] {
  const ta = lastActivity(a), tb = lastActivity(b);
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  return JSON.stringify(a.goal) >= JSON.stringify(b.goal) ? [a, b] : [b, a];
}

function pickCard(x: CardState, y: CardState): CardState {
  const rx = ms(x.card.last_review), ry = ms(y.card.last_review);
  if (rx !== ry) return rx > ry ? x : y;
  if (x.card.reps !== y.card.reps) return x.card.reps > y.card.reps ? x : y;
  return ms(x.card.due) <= ms(y.card.due) ? x : y;
}

function mergeDay(x: DayLog, y: DayLog): DayLog {
  const issues = { ...x.issues };
  for (const [k, v] of Object.entries(y.issues) as [keyof DayLog["issues"], number][]) issues[k] = Math.max(issues[k] ?? 0, v);
  return {
    seconds: Math.max(x.seconds, y.seconds),
    answers: Math.max(x.answers, y.answers),
    score: Math.max(x.score, y.score),
    newItems: Math.max(x.newItems, y.newItems),
    reviews: Math.max(x.reviews, y.reviews),
    drills: Math.max(x.drills, y.drills),
    reviewSessions: Math.max(x.reviewSessions ?? 0, y.reviewSessions ?? 0),
    lessons: [...new Set([...x.lessons, ...y.lessons])].sort(),
    issues,
  };
}

/** 键按字母排序:合并结果的 JSON 和参数顺序无关(同步时可以直接比较是否有变化) */
function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function unionEarliest(x: Record<string, string>, y: Record<string, string>): Record<string, string> {
  const out = { ...x };
  for (const [k, d] of Object.entries(y)) if (!out[k] || d < out[k]!) out[k] = d;
  return out;
}
