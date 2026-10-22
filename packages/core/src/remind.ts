import { goalMet, streak } from "./habit";
import { usualHour } from "./learner";
import { todaysReview, type Progress } from "./session";
import { addDays, atLocal, todayOf } from "./time";

/**
 * 学习提醒:在学习者自己习惯的时间点提醒(不是统一推送),内容跟着学习状态走。
 * 只排未来 3 天;3 天都没打开就不再提醒——一直轰炸只会让人关掉通知甚至卸载。
 * 每次打开 App 或学完一次,都重新排一遍。
 */
export interface StudyReminder { at: Date; body: string }

export function studyReminders(p: Progress, now: Date, days = 3): StudyReminder[] {
  const today = todayOf(p, now);
  const hour = usualHour(p);
  const goal = p.goal?.dailyMinutes ?? 10;
  const s = streak(p, now);
  const out: StudyReminder[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(today, i);
    const at = atLocal(day, hour, 0, p.tz);
    if (at.getTime() <= now.getTime()) continue;
    if (i === 0 && goalMet(p, now)) continue;
    const due = todaysReview(p, at, 50, 0).length;
    let body: string;
    if (i === days - 1) body = `好几天没见啦。今天只要 3 分钟,复习几个最容易忘的词就好。`;
    else if (i === 0 && s >= 3) body = `已经连续 ${s} 天了!今天的 ${goal} 分钟也别落下。`;
    else if (due >= 5) body = `有 ${due} 个词快要忘了,现在复习最省力。`;
    else body = `今天的 ${goal} 分钟学习计划已经准备好了。`;
    out.push({ at, body });
  }
  return out;
}
