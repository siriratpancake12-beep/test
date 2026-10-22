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
  /**
   * 下一期自动续费的商品(和 productId 不同时才有)。苹果的降级、不同时长的换档要到下一期才生效,
   * 扣费提醒必须按下一期真正要扣的商品和价格写,不能按现在的。
   */
  renewProductId?: string;
}

/**
 * 订阅事件。服务器把商店(App Store 等)的交易、通知映射成这些事件(packages/billing),
 * App 收到服务器的会员状态后也用它们对齐本地(eventsFromServer)。
 * 下面标注的可选字段只在商店确认过的数据里出现;App 本机模拟的事件不带,行为和以前一样。
 */
export type SubEvent =
  /** periodEnd:商店给的试用结束时间。有它说明试用是商店确认过的(资格由商店按 Apple ID 等判断),直接以它为准 */
  | { type: "start-trial"; productId: string; platform: Platform; at: Date; periodEnd?: Date }
  /** trialUsed:服务器记录的"是否用过试用",不给就保留本地原来的 */
  | { type: "purchase"; productId: string; platform: Platform; at: Date; periodEnd: Date; trialUsed?: boolean }
  /** productId:续费后的商品(降级、换档在续费时生效) */
  | { type: "renewed"; at: Date; periodEnd: Date; productId?: string }
  | { type: "billing-failed"; at: Date; graceEnd?: Date }
  /** productId:下一期续费的商品(商店的 autoRenewProductId) */
  | { type: "auto-renew"; on: boolean; at: Date; productId?: string }
  | { type: "expired"; at: Date }
  | { type: "refunded"; at: Date }
  | { type: "reminded"; key: string; at: Date };

const DAY_MS = 86_400_000;

export function applySubEvent(sub: Subscription | null, ev: SubEvent): Subscription | null {
  switch (ev.type) {
    case "start-trial": {
      if (ev.periodEnd) {
        // 商店确认的试用:商店已经决定给试用(不扣钱),这里只记录;扣费提醒的记录保留,免得同一条提醒再弹一次
        return {
          productId: ev.productId, platform: ev.platform, status: "trial", autoRenew: true, trialUsed: true,
          reminders: sub?.reminders ?? [], periodEnd: ev.periodEnd.toISOString(),
        };
      }
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
        trialUsed: ev.trialUsed ?? sub?.trialUsed ?? false, reminders: sub?.reminders ?? [], periodEnd: ev.periodEnd.toISOString(),
      };
    default:
      if (!sub) return null;
  }
  switch (ev.type) {
    case "renewed": {
      const { graceEnd: _, ...rest } = sub;
      const next: Subscription = { ...rest, status: "active", periodEnd: ev.periodEnd.toISOString() };
      if (!ev.productId) return next;
      // 续费时商店告诉我们这一期是什么商品:之前"下一期换成 X"的安排已经生效
      const { renewProductId: _r, ...renewed } = next;
      return { ...renewed, productId: ev.productId };
    }
    case "billing-failed":
      return ev.graceEnd ? { ...sub, status: "grace", graceEnd: ev.graceEnd.toISOString() } : { ...sub, status: "billing-retry" };
    case "auto-renew": {
      if (ev.productId === undefined) return { ...sub, autoRenew: ev.on };
      const { renewProductId: _, ...rest } = sub;
      return ev.productId === sub.productId ? { ...rest, autoRenew: ev.on } : { ...rest, autoRenew: ev.on, renewProductId: ev.productId };
    }
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
  const current = productById(sub.productId);
  // 按下一期真正要扣费的商品写价格(降级、换档要到下一期才生效)
  const product = (sub.renewProductId && productById(sub.renewProductId)) || current;
  if (!product || !current) return null;
  const left = Date.parse(sub.periodEnd) - now.getTime();
  if (left <= 0) return null;
  const window = left <= DAY_MS ? 1 : left <= 5 * DAY_MS ? 5 : null;
  if (!window) return null;
  const key = `${sub.periodEnd}@${window}`;
  if (sub.reminders.includes(key)) return null;
  const daysLeft = Math.ceil(left / DAY_MS);
  const date = sub.periodEnd.slice(0, 10);
  const kind = sub.status === "trial" ? "trial-ending" : "renewal";
  const unit = product.period === "year" ? "年" : "月";
  const zh = kind === "trial-ending"
    ? `免费试用还剩 ${daysLeft} 天,${date} 起将按 ¥${product.priceCny}/${unit} 自动续费。不想继续可以随时在系统设置里取消。`
    : product.id === current.id
      ? `你的${product.titleZh}将在 ${daysLeft} 天后(${date})自动续费 ¥${product.priceCny}。不想继续可以随时在系统设置里取消。`
      : `你的${current.titleZh}将在 ${daysLeft} 天后(${date})到期,之后自动续费${product.titleZh} ¥${product.priceCny}/${unit}。不想继续可以随时在系统设置里取消。`;
  return { key, kind, daysLeft, chargeDate: date, priceCny: product.priceCny, zh };
}

const LIVE: SubStatus[] = ["trial", "active", "grace", "billing-retry"];

/**
 * 服务器记录的会员状态 → 让本地状态和它一致的事件(以服务器为准;App 用 applySubEvent 依次应用)。
 * - 只改会员本身的字段,本地的扣费提醒记录(reminders)保留,免得同一条提醒再弹一次。
 * - 传了 local(本地现在的状态)时:已经一致就返回空数组;服务器没有记录而本地还"有效"
 *   (比如开发模式模拟开通、换了账号),就让本地过期。不传 local 时总是给出完整的事件。
 */
export function eventsFromServer(server: Subscription | null, local?: Subscription | null, at = new Date()): SubEvent[] {
  if (!server) return local && LIVE.includes(local.status) ? [{ type: "expired", at }] : [];
  const periodEnd = new Date(server.periodEnd);
  const { productId, platform } = server;
  const events: SubEvent[] = [
    server.status === "trial"
      ? { type: "start-trial", productId, platform, at, periodEnd }
      : { type: "purchase", productId, platform, at, periodEnd, trialUsed: server.trialUsed },
  ];
  if (server.status !== "revoked") events.push({ type: "auto-renew", on: server.autoRenew, at, productId: server.renewProductId ?? productId });
  if (server.status === "grace") events.push({ type: "billing-failed", at, graceEnd: server.graceEnd ? new Date(server.graceEnd) : undefined });
  if (server.status === "billing-retry") events.push({ type: "billing-failed", at });
  if (server.status === "expired") events.push({ type: "expired", at });
  if (server.status === "revoked") events.push({ type: "refunded", at });
  if (local === undefined) return events;
  const next = events.reduce<Subscription | null>((s, e) => applySubEvent(s, e), local);
  return local && next && sameSubscription(local, next) ? [] : events;
}

function sameSubscription(a: Subscription, b: Subscription): boolean {
  const pick = (s: Subscription) => [s.productId, s.platform, s.status, s.periodEnd, s.status === "grace" ? s.graceEnd : null, s.autoRenew, s.trialUsed, s.renewProductId ?? null];
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b));
}

/**
 * 免费单元:每个人免费学自己起步的那个单元(progress.freeUnit);还没确定时按课程第一单元。
 * 这样分级测试跳到 A2 的人,免费体验的也是 A2 的内容,而不是已经会了的 A1。
 */
export function isFreeLesson(lesson: Lesson, lessons: Lesson[], freeUnit?: string | null): boolean {
  if (freeUnit) return lesson.unit === freeUnit;
  const first = [...lessons].sort((a, b) => a.order - b.order)[0];
  return !!first && lesson.unit === first.unit;
}

export const canAccessLesson = (lesson: Lesson, lessons: Lesson[], premium: boolean, freeUnit?: string | null) =>
  premium || isFreeLesson(lesson, lessons, freeUnit);

/** 非强制的付费介绍(如学完免费单元后)最多 3 天出现一次,不能反复打扰。 */
export function softPaywallAllowed(lastShown: string | null, now: Date): boolean {
  return !lastShown || now.getTime() - Date.parse(lastShown) >= 3 * DAY_MS;
}
