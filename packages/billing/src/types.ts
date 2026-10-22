import type { SubEvent, Subscription } from "@lingo/core";

/**
 * 带固定 id 的订阅事件。同一件事(同一笔交易的开通、续费、退款)不管从哪条路来——App 上报、
 * 苹果服务器通知、苹果重发——id 都一样,服务器据此只记一次、只应用一次。
 */
export type StoreEvent = SubEvent & { id: string };

export interface VerifiedTransaction {
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  /** 购买时 App 传入的账号标识(UUID),用来把交易对应到我们的用户 */
  appAccountToken?: string;
  /** Production / Sandbox / …;苹果审核和 TestFlight 用沙盒,指标里要排除 */
  environment: string;
  /** 这笔交易那一期的到期时间,用来丢弃过时的数据(见 isStale) */
  periodEnd?: Date;
  events: StoreEvent[];
  /** 解码后的原始数据,存档、对账用 */
  raw?: unknown;
}

export interface VerifiedNotification {
  /** 苹果给每条通知的唯一 id,重发时不变,用来去重 */
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  /** 测试通知(TEST)等不带交易的通知没有 */
  originalTransactionId?: string;
  transactionId?: string;
  productId?: string;
  appAccountToken?: string;
  environment?: string;
  periodEnd?: Date;
  /** 苹果签名的时间 */
  signedAt: Date;
  events: StoreEvent[];
  raw?: unknown;
}

export interface AppStoreVerifier {
  verifyTransaction(signedTransaction: string): Promise<VerifiedTransaction>;
  verifyNotification(signedPayload: string): Promise<VerifiedNotification>;
}

/**
 * 签名或内容校验没通过。retryable:暂时性的失败(比如连不上苹果做证书吊销检查),稍后重试可能成功;
 * 服务器对 retryable 回 503,苹果会自动重发通知。reason 是给日志看的原因。
 */
export class StoreVerificationError extends Error {
  constructor(message: string, readonly retryable = false, readonly reason = "invalid", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StoreVerificationError";
  }
}

/**
 * 商店数据是不是"过时"的:它所属的那一期比服务器记录的当前周期还早——通知乱序到达、苹果重发、
 * App 上报了旧交易。过时的数据照样记进流水(指标要用),但不改会员状态,免得新状态被旧数据改回去
 * (比如旧一期的退款把这一期的会员撤销了)。
 *
 * 订阅已经结束(过期、撤销)时,还没结束的新一期即使比原来的短也要生效(年度退款后改买月度);
 * 已经结束的旧一期则没有意义,仍算过时。
 */
export function isStale(sub: Subscription | null, periodEnd: Date | undefined, now: Date): boolean {
  if (!sub || !periodEnd) return false;
  const older = periodEnd.getTime() < Date.parse(sub.periodEnd);
  if (sub.status === "expired" || sub.status === "revoked") return older && periodEnd.getTime() <= now.getTime();
  return older;
}
