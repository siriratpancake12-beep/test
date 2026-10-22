import { z } from "zod";
import { AppEvent } from "./events";
import { Cefr } from "./schema";

/**
 * App 和服务器之间的接口约定:路径、请求、响应。两边都从这里引用,改动必须两边一起改。
 * 出错时统一返回 HTTP 4xx/5xx + { error: { code, message } },message 是给用户看的中文。
 * 需要登录的接口带 Authorization: Bearer <token>。
 */
export const ROUTES = {
  health: "/v1/health",
  smsSend: "/v1/auth/sms/send",
  smsVerify: "/v1/auth/sms/verify",
  appleLogin: "/v1/auth/apple",
  wechatLogin: "/v1/auth/wechat",
  me: "/v1/me",
  /** DELETE:注销账号(苹果和国内法规都要求 App 内可注销) */
  account: "/v1/account",
  progress: (lang: string) => `/v1/progress/${lang}`,
  subscription: "/v1/subscription",
  /** App 买完后把交易交给服务器校验 */
  appleTransaction: "/v1/billing/apple/transaction",
  /** App Store 服务器通知(苹果服务器调用,不是 App) */
  appleNotification: "/v1/billing/apple/notification",
  events: "/v1/events",
  tutorChat: "/v1/tutor/chat",
  /** 原始音频放在请求体里,参数放在 query:?lang=de&text=... */
  speechScore: "/v1/speech/score",
  adminMetrics: "/v1/admin/metrics",
} as const;

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;

/** 中国大陆手机号 */
export const Phone = z.string().regex(/^1[3-9]\d{9}$/, "请输入正确的手机号");

export const User = z.object({
  id: z.string(),
  phone: z.string().nullable(),
  hasApple: z.boolean(),
  hasWechat: z.boolean(),
  createdAt: z.string(),
});
export type User = z.infer<typeof User>;

export const AuthResult = z.object({ token: z.string(), user: User, isNew: z.boolean() });
export type AuthResult = z.infer<typeof AuthResult>;

export const SmsSendReq = z.object({ phone: Phone });
export const SmsVerifyReq = z.object({ phone: Phone, code: z.string().regex(/^\d{6}$/) });
export const AppleLoginReq = z.object({
  identityToken: z.string().min(10),
  /** 苹果的一次性授权码:服务器用它换取刷新令牌,注销账号时向苹果撤销授权(苹果要求) */
  authorizationCode: z.string().min(1).optional(),
});
export const WechatLoginReq = z.object({ code: z.string().min(1) });

/** 进度用 JSON 传(日期是 ISO 字符串);服务器用 core 的合并规则合并多台设备的进度 */
export const ProgressRes = z.object({ progress: z.unknown().nullable(), rev: z.number().int().min(0) });
export type ProgressRes = z.infer<typeof ProgressRes>;
export const ProgressPutReq = z.object({ progress: z.unknown(), baseRev: z.number().int().min(0) });

export const SubscriptionSchema = z.object({
  productId: z.string(),
  platform: z.enum(["ios", "android", "web"]),
  status: z.enum(["trial", "active", "grace", "billing-retry", "expired", "revoked"]),
  periodEnd: z.string(),
  graceEnd: z.string().optional(),
  autoRenew: z.boolean(),
  trialUsed: z.boolean(),
  reminders: z.array(z.string()),
});
export const SubscriptionRes = z.object({ subscription: SubscriptionSchema.nullable(), premium: z.boolean() });
export type SubscriptionRes = z.infer<typeof SubscriptionRes>;
export const AppleTransactionReq = z.object({ signedTransaction: z.string().min(10) });

export const EventsReq = z.object({ events: z.array(AppEvent).min(1).max(200) });
export const EventsRes = z.object({ accepted: z.number().int() });

export const TutorMessage = z.object({ role: z.enum(["user", "tutor"]), text: z.string().min(1).max(500) });
export const TutorChatReq = z.object({
  lang: z.string(),
  scenarioId: z.string(),
  level: Cefr,
  /** 学习者学过的词(App 从进度里取,最多 400 个),AI 老师尽量只用这些词 */
  knownWords: z.array(z.string()).max(400),
  messages: z.array(TutorMessage).min(1).max(30),
});
export const TutorReply = z.object({
  /** 老师的回答(学习语言) */
  text: z.string(),
  /** 中文翻译 */
  zh: z.string(),
  /** 对学习者上一句的纠错,没有错就是空数组 */
  corrections: z.array(z.object({ original: z.string(), corrected: z.string(), explanationZh: z.string() })),
  /** 这个场景的任务是否完成(比如成功点完餐) */
  done: z.boolean(),
});
export const TutorChatRes = z.object({ reply: TutorReply, remainingToday: z.number().int() });
export type TutorChatRes = z.infer<typeof TutorChatRes>;

export const SpeechScoreRes = z.object({
  /** 0–100 */
  score: z.number(),
  accuracy: z.number(),
  fluency: z.number(),
  completeness: z.number(),
  words: z.array(z.object({ word: z.string(), score: z.number(), error: z.string() })),
});
export type SpeechScoreRes = z.infer<typeof SpeechScoreRes>;

export const MetricsRes = z.object({
  from: z.string(),
  to: z.string(),
  /** 第 N 天留存:注册后第 N 天仍有学习的比例 */
  retention: z.object({ d1: z.number().nullable(), d7: z.number().nullable(), d30: z.number().nullable() }),
  newUsers: z.number(),
  weeklyActiveLearners: z.number(),
  /** 每周学习 ≥ 3 天的付费用户数(北极星指标) */
  northStar: z.number(),
  trialStarts: z.number(),
  trialToPaid: z.number().nullable(),
  renewalRate: z.number().nullable(),
  refundRate: z.number().nullable(),
});
export type MetricsRes = z.infer<typeof MetricsRes>;
