import { z } from "zod";
import { Cefr, LangCode } from "./schema";

/**
 * AI 口语场景:学习者在一个具体情境里完成任务(点餐、问路、看房……),AI 扮演对方。
 * 场景文件放在 content/scenarios/<lang>.json(一个数组)。
 */
export const Scenario = z.object({
  /** 形如 de.cafe_order */
  id: z.string().regex(/^[a-z]{2}\.[a-z0-9_]+$/),
  lang: LangCode,
  level: Cefr,
  titleZh: z.string(),
  /** 要完成的任务,给学习者看,比如"点一杯咖啡和一块蛋糕,然后付钱" */
  goalZh: z.string(),
  /** AI 扮演的角色,比如"咖啡馆店员" */
  roleZh: z.string(),
  /** 场景说明(给 AI 的设定,中文) */
  setupZh: z.string(),
  /** AI 先说的第一句 */
  opening: z.object({ text: z.string(), zh: z.string() }),
  /** 完成任务要做到的几件事(用来判断 done) */
  tasks: z.array(z.string()).min(1),
  /** 提示学习者可以用的句子 */
  usefulPhrases: z.array(z.object({ text: z.string(), zh: z.string() })).min(1),
  /** 学完哪节课以后开放;不填就一直开放 */
  unlockAfter: z.string().optional(),
  /** 审校状态,和课程一样:上线前要母语者审过 */
  review: z.enum(["draft", "ai", "native"]).default("draft"),
});
export type Scenario = z.infer<typeof Scenario>;
