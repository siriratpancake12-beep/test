import { isActiveDay, streak } from "./habit";
import { activeVocab, skillScores, weaknesses, type Weakness } from "./learner";
import type { Lesson } from "./schema";
import type { IssueKind, Progress, Skill4 } from "./session";
import { lastDays, todayOf } from "./time";

/**
 * 周报:让进步看得见。续订的人和退订的人最大的区别,是"觉得自己在进步"。
 * 只放学习者能感知的东西:这周学会做什么事、能主动用多少词、哪个错误改掉了。
 */
export interface WeeklyReport {
  from: string;
  to: string;
  activeDays: number;
  minutes: number;
  prevMinutes: number;
  newItems: number;
  answers: number;
  /** 正确率(0–1),没答题为 null */
  accuracy: number | null;
  prevAccuracy: number | null;
  /** 现在能主动用(看中文能写出来)的词数 */
  activeWords: number;
  /** 这周学完的课对应的"能做到的事" */
  canDo: string[];
  streak: number;
  skills: Record<Skill4, number | null>;
  /** 这周比上周改善最多的错误类型 */
  improved?: { kind: IssueKind; zh: string; thisWeek: number; lastWeek: number };
  /** 还要重点练的 */
  focus?: Weakness & { zh: string };
}

function sum(p: Progress, days: string[]) {
  let minutes = 0, newItems = 0, answers = 0, score = 0;
  const issues: Partial<Record<IssueKind, number>> = {};
  for (const d of days) {
    const l = p.log[d];
    if (!l) continue;
    minutes += l.seconds / 60;
    newItems += l.newItems;
    answers += l.answers;
    score += l.score;
    for (const [k, v] of Object.entries(l.issues) as [IssueKind, number][]) issues[k] = (issues[k] ?? 0) + v;
  }
  return { minutes: Math.round(minutes), newItems, answers, accuracy: answers ? score / answers : null, issues };
}

const ISSUE_NAME: Record<IssueKind, string> = {
  article: "冠词/名词的性",
  accent: "重音符号",
  case: "名词大写",
  typo: "拼写",
  "umlaut-fallback": "变音字母",
  reading: "汉字写法",
};

const ISSUE_TIP: Record<IssueKind, string> = {
  article: "名词一定连冠词一起记,写之前先想它是阳性、阴性还是中性",
  accent: "é è à ç 这些符号会改变读音,不能省",
  case: "德语所有名词首字母都大写",
  typo: "长词写之前先在心里读一遍",
  "umlaut-fallback": "直接输入 ä ö ü ß(手机上长按 a、o、u、s)",
  reading: "汉字词试着直接写汉字",
};

export function weeklyReport(p: Progress, lessons: Lesson[], now: Date): WeeklyReport {
  const today = todayOf(p, now);
  const days = lastDays(today, 14);
  const week = days.slice(0, 7);
  const cur = sum(p, week);
  const prev = sum(p, days.slice(7));

  const newItems = Object.values(p.learned).filter((d) => week.includes(d)).length;
  const titles = new Map(lessons.map((l) => [l.id, l.canDoZh]));
  const canDo = Object.entries(p.completed)
    .filter(([, d]) => week.includes(d))
    .map(([id]) => titles.get(id))
    .filter((x): x is string => !!x);

  // 改善:上周至少错 3 次,这周按答题量折算后明显减少
  let improved: WeeklyReport["improved"];
  for (const [kind, last] of Object.entries(prev.issues) as [IssueKind, number][]) {
    const now7 = cur.issues[kind] ?? 0;
    const rateNow = cur.answers ? now7 / cur.answers : 0;
    const rateLast = prev.answers ? last / prev.answers : 0;
    if (last >= 3 && cur.answers >= 10 && rateNow <= rateLast * 0.5 && (!improved || last - now7 > improved.lastWeek - improved.thisWeek)) {
      improved = { kind, zh: ISSUE_NAME[kind], thisWeek: now7, lastWeek: last };
    }
  }
  const top = weaknesses(p, now)[0];

  return {
    from: week.at(-1)!,
    to: today,
    activeDays: week.filter((d) => isActiveDay(p.log[d])).length,
    minutes: cur.minutes,
    prevMinutes: prev.minutes,
    newItems,
    answers: cur.answers,
    accuracy: cur.accuracy,
    prevAccuracy: prev.accuracy,
    activeWords: activeVocab(p, now),
    canDo,
    streak: streak(p, now),
    skills: skillScores(p),
    ...(improved ? { improved } : {}),
    ...(top ? { focus: { ...top, zh: `${ISSUE_NAME[top.kind]}:${ISSUE_TIP[top.kind]}` } } : {}),
  };
}

export const issueName = (k: IssueKind) => ISSUE_NAME[k];
