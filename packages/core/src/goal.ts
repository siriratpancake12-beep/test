import type { Cefr, LanguagePack, Lesson } from "./schema";
import { isActiveDay } from "./habit";
import type { Progress } from "./session";
import { addDays, daysBetween, lastDays, todayOf } from "./time";

/**
 * 学习目标和预估。
 *
 * 开始学之前就告诉学习者:"按每天 15 分钟,预计 2027 年 8 月达到 B1"。
 * 有了具体目标和日期,才有坚持(和续订)的理由;目标定得不现实时也要直说
 * ("6 个月考 TEF B2 需要每天约 90 分钟"),期望一开始就对齐,后面才不会失望退订。
 */
export type GoalKind = "exam" | "study-abroad" | "immigration" | "work" | "travel" | "interest";

export const GOAL_KINDS: { kind: GoalKind; zh: string }[] = [
  { kind: "exam", zh: "考试/考证" },
  { kind: "study-abroad", zh: "出国留学" },
  { kind: "immigration", zh: "移民" },
  { kind: "work", zh: "工作需要" },
  { kind: "travel", zh: "旅行" },
  { kind: "interest", zh: "兴趣爱好" },
];

export interface Goal {
  kind: GoalKind;
  target: Cefr;
  dailyMinutes: number;
  /** 想在哪天之前达到(当地日期),可不填 */
  deadline?: string;
  exam?: string;
}

export const CEFR_ORDER: Cefr[] = ["pre-A1", "A1", "A2", "B1", "B2", "C1"];

/**
 * 从零达到各等级的累计学时(估算)。参考各语种官方机构的建议学时;
 * 对中文母语者,德法西俄这些与中文差异大的语言通常要更多时间。上线后用真实数据校准。
 */
export const DEFAULT_HOURS: Record<Cefr, number> = { "pre-A1": 20, A1: 80, A2: 200, B1: 400, B2: 600, C1: 850 };

export const hoursToReach = (pack: LanguagePack, level: Cefr) => pack.hoursToLevel?.[level] ?? DEFAULT_HOURS[level];

/** 复习、练习、读对话的时间大约是课程标注时间的 1.4 倍 */
const OVERHEAD = 1.4;

/** 已投入的学时:实际学习时长 + 分级测试跳过的课(按课时折算)。 */
export function studiedHours(p: Progress, lessons: Lesson[]): number {
  const secs = Object.values(p.log).reduce((a, d) => a + d.seconds, 0);
  const skippedMin = lessons.filter((l) => p.skipped.includes(l.id)).reduce((a, l) => a + l.estimatedMinutes * OVERHEAD, 0);
  return secs / 3600 + skippedMin / 60;
}

export interface Projection {
  target: Cefr;
  totalHours: number;
  doneHours: number;
  remainingHours: number;
  /** 按目前节奏,平均每个自然日学多少分钟 */
  minutesPerDay: number;
  /** true = 用的是真实学习记录;false = 还没有足够记录,按设定的每日目标估 */
  basedOnHistory: boolean;
  etaDay: string;
  /**
   * 沿途的里程碑(还没达到的等级,到目标为止)。终点太远时,先看到"下一站",更有动力。
   */
  milestones: { level: Cefr; etaDay: string }[];
  daysLeft?: number;
  onTrack?: boolean;
  /** 要按期达到,每天需要学多少分钟 */
  neededMinutes?: number;
}

/** 一周大约学 6 天 */
const TYPICAL_ACTIVE_RATIO = 6 / 7;

export function projection(p: Progress, pack: LanguagePack, lessons: Lesson[], now: Date): Projection | null {
  if (!p.goal) return null;
  const today = todayOf(p, now);
  const totalHours = hoursToReach(pack, p.goal.target);
  const doneHours = studiedHours(p, lessons);
  const remainingHours = Math.max(0, totalHours - doneHours);

  // 学了 5 天以上,就用最近两周真实的节奏,而不是学习者自己设的目标
  const recent = lastDays(today, 14);
  const active = recent.filter((d) => isActiveDay(p.log[d])).length;
  const basedOnHistory = active >= 5;
  const minutesPerDay = basedOnHistory
    ? recent.reduce((a, d) => a + (p.log[d]?.seconds ?? 0), 0) / 60 / 14
    : p.goal.dailyMinutes * TYPICAL_ACTIVE_RATIO;
  // 减一个极小量再取整:210.00000000000003 这种浮点误差不能变成 211 天
  const ceil = (x: number) => Math.ceil(x - 1e-9);
  const daysFor = (hours: number) => (hours <= 0 ? 0 : ceil((hours * 60) / Math.max(minutesPerDay, 1)));
  const etaDays = daysFor(remainingHours);
  const milestones = CEFR_ORDER.slice(1, CEFR_ORDER.indexOf(p.goal.target) + 1)
    .filter((lv) => hoursToReach(pack, lv) > doneHours)
    .map((lv) => ({ level: lv, etaDay: addDays(today, daysFor(hoursToReach(pack, lv) - doneHours)) }));
  const out: Projection = { target: p.goal.target, totalHours, doneHours, remainingHours, minutesPerDay, basedOnHistory, etaDay: addDays(today, etaDays), milestones };

  if (p.goal.deadline) {
    const daysLeft = Math.max(1, daysBetween(today, p.goal.deadline));
    out.daysLeft = daysLeft;
    out.onTrack = etaDays <= daysLeft;
    out.neededMinutes = ceil((remainingHours * 60) / (daysLeft * TYPICAL_ACTIVE_RATIO));
  }
  return out;
}

export interface LevelProgress { level: Cefr; total: number; done: number }

/** 课程里每个等级学完了多少节(首页的进度条)。 */
export function levelProgress(p: Progress, lessons: Lesson[]): LevelProgress[] {
  return CEFR_ORDER.flatMap((level) => {
    const ls = lessons.filter((l) => l.cefr === level);
    if (!ls.length) return [];
    return [{ level, total: ls.length, done: ls.filter((l) => l.id in p.completed || p.skipped.includes(l.id)).length }];
  });
}
