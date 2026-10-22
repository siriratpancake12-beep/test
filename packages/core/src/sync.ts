import { z } from "zod";
import { normalizeProgress, type DayLog, type IssueStat, type Progress } from "./session";
import type { CardState } from "./srs";

/**
 * 多台设备的进度合并(手机 + 平板、重装后、离线学了一阵再联网)。
 * 原则:不丢任何学习记录;同样的两份进度不管谁先谁后,合并结果一样;重复合并不改变结果。
 *
 * - 学过的课、学过的词、跳过的课:取并集(日期取更早的)
 * - 复习卡:取最后一次复习更晚的那张(两边都没复习过就取到期更早的)
 * - 每天的日志:每一项取较大值(同一天两台设备各学一部分时会少算,但绝不会重复算)
 * - 目标、时区等设置:取最近有学习活动的那份
 *
 * "和顺序无关"要求每一步比较都分得出先后:学习时间一样(比如两台都还没学)、两张卡复习记录一样时,
 * 最后按内容定,不能按"谁是第一个参数"定。
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
  for (const [k, st] of Object.entries(newer.issues) as [keyof Progress["issues"], IssueStat][]) {
    const o = issues[k];
    issues[k] = !o ? st : pickIssue(o, st);
  }

  const checkpoints = new Map<string, Progress["checkpoints"][number]>();
  for (const c of [...older.checkpoints, ...newer.checkpoints]) checkpoints.set(canonical([c.day, c.lessonId, c.score]), c);

  const hours = Array.from({ length: Math.max(newer.hours.length, older.hours.length) }, (_, i) => Math.max(newer.hours[i] ?? 0, older.hours[i] ?? 0));

  // 顶层的键也排好序:结果的 JSON 只取决于内容
  return sortKeys({
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
    hours,
    checkpoints: [...checkpoints.entries()].sort(([x], [y]) => cmp(x, y)).map(([, c]) => c),
  }) as unknown as Progress;
}

/** 时间(Date 或 ISO 字符串)→ 毫秒;没有或格式坏了算 0,保证比较总有结果(NaN 和谁比都是 false,会让结果取决于参数顺序) */
const ms = (d: Date | string | undefined | null) => {
  const t = d ? new Date(d).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

/** 最近一次学习活动的时间:日志里最晚的一天,或最晚一次复习 */
function lastActivity(p: Progress): number {
  let t = 0;
  for (const day of Object.keys(p.log)) t = Math.max(t, ms(`${day}T00:00:00Z`));
  for (const c of Object.values(p.cards)) t = Math.max(t, ms(c.card.last_review));
  return t;
}

/**
 * 按最近活动排出"新、旧"。一样新时:设置过目标的那份算新(另一台多半是刚装、还没做新用户引导);
 * 还分不出就按内容排,保证结果和参数顺序无关。
 */
function order(a: Progress, b: Progress): [Progress, Progress] {
  const ta = lastActivity(a), tb = lastActivity(b);
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  if (!a.goal !== !b.goal) return a.goal ? [a, b] : [b, a];
  return canonical(a) >= canonical(b) ? [a, b] : [b, a];
}

function pickCard(x: CardState, y: CardState): CardState {
  const rx = ms(x.card.last_review), ry = ms(y.card.last_review);
  if (rx !== ry) return rx > ry ? x : y;
  if (x.card.reps !== y.card.reps) return x.card.reps > y.card.reps ? x : y;
  const dx = ms(x.card.due), dy = ms(y.card.due);
  if (dx !== dy) return dx < dy ? x : y;
  return canonical(x) <= canonical(y) ? x : y;
}

/** 弱点:取最近一次犯错更晚的;同一时刻取权重大的 */
function pickIssue(x: IssueStat, y: IssueStat): IssueStat {
  if (x.at !== y.at) return x.at > y.at ? x : y;
  return x.weight >= y.weight ? x : y;
}

function mergeDay(x: DayLog, y: DayLog): DayLog {
  const issues = { ...x.issues };
  for (const [k, v] of Object.entries(y.issues) as [keyof DayLog["issues"], number][]) issues[k] = Math.max(issues[k] ?? 0, v);
  return {
    // 以后版本加的字段也保留下来
    ...x,
    ...y,
    seconds: Math.max(x.seconds, y.seconds),
    answers: Math.max(x.answers, y.answers),
    score: Math.max(x.score, y.score),
    newItems: Math.max(x.newItems, y.newItems),
    reviews: Math.max(x.reviews, y.reviews),
    drills: Math.max(x.drills, y.drills),
    reviewSessions: Math.max(x.reviewSessions ?? 0, y.reviewSessions ?? 0),
    lessons: [...new Set([...x.lessons, ...y.lessons])].sort(),
    issues: sortKeys(issues),
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 键按字母排序:合并结果的 JSON 和参数顺序无关(同步时可以直接比较是否有变化) */
function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));
}

/** 和键的顺序无关的 JSON(用来按内容比较;日期先变成 ISO 字符串) */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val) ? sortKeys(val as Record<string, unknown>) : val,
  );
}

function unionEarliest(x: Record<string, string>, y: Record<string, string>): Record<string, string> {
  const out = { ...x };
  for (const [k, d] of Object.entries(y)) if (!out[k] || d < out[k]!) out[k] = d;
  return out;
}

/**
 * 从网络或存储收到的进度(JSON):先检查结构,再用 normalizeProgress 补齐新版本加的字段。
 * 结构不对返回 null。服务器靠它挡住坏数据:存进去的进度会下发给这个人的所有设备,也会参与合并,
 * 一份坏数据(比如 cards 是 null)会让合并直接出错、让其他设备的 App 崩溃。
 * 检查得比较宽:不认识的字段原样保留(新版本 App 加的字段不会因为服务器还没升级而丢掉)。
 */
export function parseProgress(raw: unknown): Progress | null {
  const r = ProgressShape.safeParse(raw);
  if (!r.success) return null;
  // 值是 undefined 的键去掉,免得 normalizeProgress 合并默认值时被覆盖成 undefined
  const clean = Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) as Record<string, unknown> & { lang: string };
  return normalizeProgress(clean);
}

const Day = /^\d{4}-\d{2}-\d{2}$/;
const DateLike = z.union([z.string(), z.date()]);
const ProgressShape = z.looseObject({
  lang: z.string().min(1).max(16),
  tz: z.number().optional(),
  goal: z.looseObject({ kind: z.string(), target: z.string(), dailyMinutes: z.number() }).nullable().optional(),
  completed: z.record(z.string(), z.string()).optional(),
  skipped: z.array(z.string()).optional(),
  freeUnit: z.string().nullable().optional(),
  learned: z.record(z.string(), z.string()).optional(),
  cards: z
    .record(
      z.string(),
      z.looseObject({
        itemId: z.string(),
        direction: z.enum(["recognize", "listen", "produce"]),
        card: z.looseObject({
          due: DateLike,
          last_review: DateLike.nullish(),
          reps: z.number(),
          lapses: z.number(),
          state: z.number(),
          stability: z.number(),
          difficulty: z.number(),
        }),
      }),
    )
    .optional(),
  log: z
    .record(
      z.string().regex(Day),
      // 旧版本可能缺某些字段:按 0 补上(合并取较大值,缺字段会算出 NaN)
      z.looseObject({
        seconds: z.number().default(0),
        answers: z.number().default(0),
        score: z.number().default(0),
        newItems: z.number().default(0),
        reviews: z.number().default(0),
        drills: z.number().default(0),
        reviewSessions: z.number().default(0),
        lessons: z.array(z.string()).default([]),
        issues: z.record(z.string(), z.number()).default({}),
      }),
    )
    .optional(),
  recent: z.record(z.string(), z.array(z.number())).optional(),
  issues: z.record(z.string(), z.looseObject({ weight: z.number(), at: z.string() })).optional(),
  freezes: z.number().optional(),
  frozenDays: z.array(z.string()).optional(),
  hours: z.array(z.number()).max(48).optional(),
  checkpoints: z.array(z.looseObject({ lessonId: z.string(), day: z.string(), score: z.number() })).optional(),
  // 第一版的字段,normalizeProgress 会转换
  completedLessons: z.array(z.string()).optional(),
  activeDays: z.array(z.string()).optional(),
});

/**
 * 同步用的紧凑格式(wire)。复习卡是进度里最大的部分(一门课学完约 7500 张),
 * 从对象改成数字数组后体积约为原来的三分之一,学完整门课也远低于服务器的上限。
 *
 * cards 的每一项:[due(秒), stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review(秒,没有为 0)]
 * 键仍是 "<itemId>#<direction>"。其他字段和 Progress 一样。
 */
export interface WireProgress extends Omit<Progress, "cards"> {
  wire: 1;
  cards: Record<string, number[]>;
}

const sec = (d: Date | string | undefined | null) => (d ? Math.round(new Date(d).getTime() / 1000) : 0);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function toWire(p: Progress): WireProgress {
  const cards: Record<string, number[]> = {};
  for (const [k, { card: c }] of Object.entries(p.cards)) {
    cards[k] = [sec(c.due), r4(c.stability), r4(c.difficulty), c.elapsed_days, c.scheduled_days, c.learning_steps ?? 0, c.reps, c.lapses, c.state, sec(c.last_review)];
  }
  return { ...p, wire: 1, cards };
}

/** 读同步数据:紧凑格式和普通格式都认;格式不对返回 null(不要把坏数据合并进来) */
export function fromWire(raw: unknown): Progress | null {
  if (!raw || typeof raw !== "object" || (raw as { wire?: unknown }).wire !== 1) return parseProgress(raw);
  const { wire: _w, cards: packed, ...rest } = raw as WireProgress;
  if (!packed || typeof packed !== "object") return null;
  const cards: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(packed)) {
    const cut = k.lastIndexOf("#");
    if (cut <= 0 || !Array.isArray(a) || a.length < 10 || a.some((x) => typeof x !== "number")) return null;
    const [due, stability, difficulty, elapsed, scheduled, steps, reps, lapses, state, last] = a as number[];
    cards[k] = {
      itemId: k.slice(0, cut),
      direction: k.slice(cut + 1),
      card: {
        due: new Date(due! * 1000), stability, difficulty, elapsed_days: elapsed, scheduled_days: scheduled, learning_steps: steps,
        reps, lapses, state, ...(last ? { last_review: new Date(last * 1000) } : {}),
      },
    };
  }
  return parseProgress({ ...rest, cards });
}
