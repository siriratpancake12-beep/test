import { estimateLessonMinutes } from "./hours";
import { engagement, pace, topWeakness, type Pace } from "./learner";
import type { Lesson } from "./schema";
import { nextLesson, todaysReview, type IssueKind, type Progress } from "./session";
import { todayOf } from "./time";

/**
 * 每日计划:打开 App 就知道今天做什么、要多久,不用自己想。
 * 顺序按学习效果排:先复习(趁快忘的时候巩固,性价比最高)→ 弱点专练 → 新课。
 */
export type Block =
  | { kind: "review"; cards: number; minutes: number; done: boolean }
  | { kind: "drill"; weakness: IssueKind; minutes: number; done: boolean; locked: boolean }
  | { kind: "lesson"; lessonId: string; minutes: number; done: boolean; locked: boolean };

export interface PlanNote { code: "comeback" | "slower" | "faster" | "course-finished"; zh: string }

export interface DailyPlan {
  blocks: Block[];
  minutes: number;
  mode: "normal" | "comeback";
  pace: Pace;
  notes: PlanNote[];
}

/** 一分钟大约复习 5 张卡 */
export const CARDS_PER_MIN = 5;
const DRILL_MIN = 3;

export interface PlanOptions {
  premium: boolean;
  /** 这节课当前账号能不能学(免费/会员) */
  canAccess: (lesson: Lesson) => boolean;
}

// 离开 3 天以上:只安排少量最重要的复习,让回归的第一天轻松完成,而不是面对几百张积压
const isComeback = (p: Progress, now: Date) => engagement(p, now).daysAway >= 3;

/** 今天一次复习最多几张卡:平时占每日目标的一半时间,回归日可以占满(但不学新课)。 */
export function reviewCap(p: Progress, now: Date): number {
  const goal = p.goal?.dailyMinutes ?? 10;
  return (isComeback(p, now) ? goal : Math.max(3, Math.round(goal * 0.5))) * CARDS_PER_MIN;
}

export function dailyPlan(p: Progress, lessons: Lesson[], now: Date, opts: PlanOptions): DailyPlan {
  const goal = p.goal?.dailyMinutes ?? 10;
  const log = p.log[todayOf(p, now)];
  const sp = pace(p);
  const comeback = isComeback(p, now);
  const notes: PlanNote[] = [];
  const blocks: Block[] = [];

  const due = todaysReview(p, now, reviewCap(p, now)).length;
  const reviewedToday = (log?.reviewSessions ?? 0) > 0;
  if (due > 0 || reviewedToday) {
    blocks.push({ kind: "review", cards: due, minutes: Math.max(1, Math.ceil(due / CARDS_PER_MIN)), done: due === 0 || reviewedToday });
  }
  let left = goal - (blocks[0]?.minutes ?? 0);

  const weak = topWeakness(p, now);
  if (weak && (left >= DRILL_MIN || sp === "slower")) {
    blocks.push({ kind: "drill", weakness: weak.kind, minutes: DRILL_MIN, done: (log?.drills ?? 0) > 0, locked: !opts.premium });
    left -= DRILL_MIN;
  }

  // 今天已经学完的课算在计划里(打勾);还没学就排下一节
  const doneToday = lessons.find((l) => log?.lessons.includes(l.id));
  const next = doneToday ?? nextLesson(lessons, p);
  const tooMuchBacklog = sp === "slower" && due >= 20;
  if (next && (doneToday || (!comeback && !tooMuchBacklog) || due === 0)) {
    blocks.push({ kind: "lesson", lessonId: next.id, minutes: Math.round(estimateLessonMinutes(next)), done: !!doneToday, locked: !opts.canAccess(next) });
  }

  if (comeback) notes.push({ code: "comeback", zh: `欢迎回来!今天先把最容易忘的 ${due} 张卡复习一下,${blocks[0]?.minutes ?? 1} 分钟就好。` });
  else if (sp === "slower") notes.push({ code: "slower", zh: "最近的题有点难,今天多复习、少学新的,先把基础打牢。" });
  else if (sp === "faster") notes.push({ code: "faster", zh: "你学得很轻松,可以做个跳级测试,直接学更难的内容。" });
  if (!next) notes.push({ code: "course-finished", zh: "现有课程都学完了!新课陆续上线,先保持复习。" });

  return { blocks, minutes: blocks.reduce((a, b) => a + b.minutes, 0), mode: comeback ? "comeback" : "normal", pace: sp, notes };
}
