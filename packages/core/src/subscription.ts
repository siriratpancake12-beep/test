import type { Lesson } from "./schema";

/**
 * 会员订阅。
 *
 * 原则(我们要的是"学得好所以续",不是"忘了取消所以续"):
 * 1. 每次自动扣费前 5 天和前 1 天都提醒,试用转正也一样。这既是《网络交易监督管理办法》第十八条
 *    对自动续费的要求,也能减少退款、投诉和差评——这些对长期续订率的伤害远大于多扣到的一个月。
 * 2. 复习永远免费:学过的内容随时能复习,不拿学习者的记忆当人质。
 * 3. 免费部分要足够让人体验到效果(完整的第一单元、分级测试、学习计划、每日复习);
 *    付费墙出现在"想继续"的时刻(学完免费单元、想学下一课、想做弱点专练),不在学到一半时弹。
 *
 * 状态流转对应 App Store / Google Play 的服务器通知;以服务器记录为准,App 只做展示和兜底判断。
 */
export type Platform = "ios" | "android" | "web";
export type SubStatus = "trial" | "active" | "grace" | "billing-retry" | "expired" | "revoked";

export interface Product {
  id: string;
  period: "month" | "year";
  /** 价格(人民币元)。正式定价上线前由负责人确认,并用 A/B 测试校准 */
  priceCny: number;
  trialDays: number;
  titleZh: string;
}

/** 试用只放在年度会员上:愿意试用的人多半是认真想学的,年付也让他们有足够时间看到效果。 */
export const PRODUCTS: Product[] = [
  { id: "premium_yearly", period: "year", priceCny: 298, trialDays: 7, titleZh: "年度会员" },
  { id: "premium_monthly", period: "month", priceCny: 45, trialDays: 0, titleZh: "月度会员" },
];

export const productById = (id: string) => PRODUCTS.find((p) => p.id === id);
export const monthlyPrice = (p: Product) => (p.period === "year" ? Math.round((p.priceCny / 12) * 10) / 10 : p.priceCny);

export interface Subscription {
  productId: string;
  platform: Platform;
  status: SubStatus;
  /** 当前周期(或试用)结束时间 */
  periodEnd: string;
  /** 扣费失败时商店的宽限期,期间照常使用 */
  graceEnd?: string;
  autoRenew: boolean;
  trialUsed: boolean;
  /** 已发过的扣费提醒,形如 "<periodEnd>@5" */
  reminders: string[];
}

export type SubEvent =
  | { type: "start-trial"; productId: string; platform: Platform; at: Date }
  | { type: "purchase"; productId: string; platform: Platform; at: Date; periodEnd: Date }
  | { type: "renewed"; at: Date; periodEnd: Date }
  | { type: "billing-failed"; at: Date; graceEnd?: Date }
  | { type: "auto-renew"; on: boolean; at: Date }
  | { type: "expired"; at: Date }
  | { type: "refunded"; at: Date }
  | { type: "reminded"; key: string; at: Date };

const DAY_MS = 86_400_000;

export function applySubEvent(sub: Subscription | null, ev: SubEvent): Subscription | null {
  switch (ev.type) {
    case "start-trial": {
      const product = productById(ev.productId);
      // 每个账号只能试用一次
      if (!product?.trialDays || sub?.trialUsed) return sub;
      return {
        productId: ev.productId, platform: ev.platform, status: "trial", autoRenew: true, trialUsed: true, reminders: [],
        periodEnd: new Date(ev.at.getTime() + product.trialDays * DAY_MS).toISOString(),
      };
    }
    case "purchase":
      return {
        productId: ev.productId, platform: ev.platform, status: "active", autoRenew: true,
        trialUsed: sub?.trialUsed ?? false, reminders: sub?.reminders ?? [], periodEnd: ev.periodEnd.toISOString(),
      };
    default:
      if (!sub) return null;
  }
  switch (ev.type) {
    case "renewed": {
      const { graceEnd: _, ...rest } = sub;
      return { ...rest, status: "active", periodEnd: ev.periodEnd.toISOString() };
    }
    case "billing-failed":
      return ev.graceEnd ? { ...sub, status: "grace", graceEnd: ev.graceEnd.toISOString() } : { ...sub, status: "billing-retry" };
    case "auto-renew":
      return { ...sub, autoRenew: ev.on };
    case "expired":
      return { ...sub, status: "expired", autoRenew: false };
    case "refunded":
      return { ...sub, status: "revoked", autoRenew: false };
    case "reminded":
      return sub.reminders.includes(ev.key) ? sub : { ...sub, reminders: [...sub.reminders, ev.key] };
  }
}

export function isPremium(sub: Subscription | null, now: Date): boolean {
  if (!sub) return false;
  const t = now.getTime();
  if (sub.status === "trial" || sub.status === "active") return t < Date.parse(sub.periodEnd);
  if (sub.status === "grace") return !!sub.graceEnd && t < Date.parse(sub.graceEnd);
  return false;
}

export interface RenewalReminder {
  key: string;
  kind: "trial-ending" | "renewal";
  daysLeft: number;
  chargeDate: string;
  priceCny: number;
  zh: string;
}

/** 扣费前提醒:前 5 天一次、前 1 天一次。已关闭自动续费的不提醒。 */
export function renewalReminder(sub: Subscription | null, now: Date): RenewalReminder | null {
  if (!sub || !sub.autoRenew || (sub.status !== "trial" && sub.status !== "active")) return null;
  const product = productById(sub.productId);
  if (!product) return null;
  const left = Date.parse(sub.periodEnd) - now.getTime();
  if (left <= 0) return null;
  const window = left <= DAY_MS ? 1 : left <= 5 * DAY_MS ? 5 : null;
  if (!window) return null;
  const key = `${sub.periodEnd}@${window}`;
  if (sub.reminders.includes(key)) return null;
  const daysLeft = Math.ceil(left / DAY_MS);
  const date = sub.periodEnd.slice(0, 10);
  const kind = sub.status === "trial" ? "trial-ending" : "renewal";
  const zh = kind === "trial-ending"
    ? `免费试用还剩 ${daysLeft} 天,${date} 起将按 ¥${product.priceCny}/${product.period === "year" ? "年" : "月"} 自动续费。不想继续可以随时在系统设置里取消。`
    : `你的${product.titleZh}将在 ${daysLeft} 天后(${date})自动续费 ¥${product.priceCny}。不想继续可以随时在系统设置里取消。`;
  return { key, kind, daysLeft, chargeDate: date, priceCny: product.priceCny, zh };
}

/** 第一单元(按顺序最前面的单元)免费,其余要会员。 */
export function isFreeLesson(lesson: Lesson, lessons: Lesson[]): boolean {
  const first = [...lessons].sort((a, b) => a.order - b.order)[0];
  return !!first && lesson.unit === first.unit;
}

export const canAccessLesson = (lesson: Lesson, lessons: Lesson[], premium: boolean) => premium || isFreeLesson(lesson, lessons);

/** 非强制的付费介绍(如学完免费单元后)最多 3 天出现一次,不能反复打扰。 */
export function softPaywallAllowed(lastShown: string | null, now: Date): boolean {
  return !lastShown || now.getTime() - Date.parse(lastShown) >= 3 * DAY_MS;
}
