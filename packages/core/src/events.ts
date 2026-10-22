import { z } from "zod";

/**
 * 行为数据(埋点)。只记"做了什么",不记个人信息:anonId 是安装时随机生成的,
 * 登录后服务器按 token 关联账号。用于计算留存、转化、续订和学习效果,以及做 A/B 测试。
 *
 * 各事件的 props(只放这些,不要放用户输入的内容):
 * - app_open:                —
 * - onboarding_complete:     goalKind, target, dailyMinutes, hasDeadline, hasBase
 * - placement_complete:      passedLevels(逗号分隔), questions, correct
 * - plan_view:               first(是否新用户引导中)
 * - lesson_start / lesson_complete: lessonId, (complete 另有)correct, total, seconds
 * - review_complete:         cards, correct
 * - drill_complete:          weakness, total, correct
 * - checkpoint_complete:     unit, score, total
 * - paywall_view:            reason
 * - trial_start / purchase:  productId
 * - restore:                 found
 * - report_view:             premium
 * - notification_prompt:     granted
 * - login:                   method(sms / apple / wechat), isNew
 * - logout / account_delete: —
 * - tutor_message:           scenarioId
 * - speech_attempt:          scored(是否有服务器打分), score
 * - goal_change:             target, dailyMinutes
 */
export const EventName = z.enum([
  "app_open", "onboarding_complete", "placement_complete", "plan_view",
  "lesson_start", "lesson_complete", "review_complete", "drill_complete", "checkpoint_complete",
  "paywall_view", "trial_start", "purchase", "restore",
  "report_view", "notification_prompt", "login", "logout", "account_delete",
  "tutor_message", "speech_attempt", "goal_change",
]);
export type EventName = z.infer<typeof EventName>;

export const AppEvent = z.object({
  /** 客户端生成的唯一 id,服务器按它去重(重试上传不会重复计数) */
  id: z.string().min(8).max(64),
  name: EventName,
  at: z.string().datetime(),
  anonId: z.string().min(8).max(64),
  lang: z.string().max(8).optional(),
  props: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).default({}),
  platform: z.enum(["ios", "android", "web"]),
  appVersion: z.string().max(32),
});
export type AppEvent = z.infer<typeof AppEvent>;
