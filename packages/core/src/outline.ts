import { z } from "zod";
import { Cefr, LangCode, Lesson } from "./schema";

/**
 * 课程大纲:整门课的骨架(单元、每节课的目标、每节课新教哪些词)。
 * 先定大纲、再分头写课:大纲是词条的总登记处,保证几个人同时写也不会重复教同一个词、
 * 不会用到还没教的词。课写好以后,以课文件为准;写好的课的新词必须和大纲一致。
 */
export const OutlineLesson = Lesson.pick({
  id: true, lang: true, type: true, cefr: true, unit: true, order: true, titleZh: true, goalZh: true, canDoZh: true,
  skills: true, estimatedMinutes: true, newItems: true, reviewItems: true,
}).extend({
  /** 这节课的场景(给写课的人看) */
  scenarioZh: z.string(),
  /** 这节课的语法重点 */
  grammarFocusZh: z.string().optional(),
});
export type OutlineLesson = z.infer<typeof OutlineLesson>;

export const Outline = z.object({
  lang: LangCode,
  levels: z.array(Cefr).min(1),
  units: z.array(z.object({ unit: z.string(), cefr: Cefr, themeZh: z.string() })).min(1),
  lessons: z.array(OutlineLesson).min(1),
});
export type Outline = z.infer<typeof Outline>;

/** 课还没写好时,用大纲里的信息顶上:分批写课时,前面的课没写完也能校验后面的课。 */
export function stubLesson(o: OutlineLesson): Lesson {
  const { scenarioZh: _s, grammarFocusZh: _g, ...rest } = o;
  return Lesson.parse({ ...rest, schemaVersion: 1, lines: [], grammar: [], review: "draft" });
}
