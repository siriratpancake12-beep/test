import type { SubEvent } from "@lingo/core";

/**
 * 支付校验:App Store(和以后的安卓渠道)交易、服务器通知 → 订阅事件(core 的 SubEvent)。
 * 负责人:billing。服务器的 routes/billing.ts 通过这个接口调用,测试里可以换成假的。
 */
export interface VerifiedTransaction {
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  /** 购买时 App 传入的账号标识(UUID),用来把交易对应到我们的用户 */
  appAccountToken?: string;
  environment: string;
  events: SubEvent[];
}

export interface VerifiedNotification {
  notificationType: string;
  subtype?: string;
  originalTransactionId: string;
  appAccountToken?: string;
  events: SubEvent[];
}

export interface AppStoreVerifier {
  verifyTransaction(signedTransaction: string): Promise<VerifiedTransaction>;
  verifyNotification(signedPayload: string): Promise<VerifiedNotification>;
}
