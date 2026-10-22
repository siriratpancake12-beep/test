import {
  AutoRenewStatus, InAppOwnershipType, NotificationTypeV2, OfferDiscountType, OfferType, Subtype, TransactionReason, Type,
  type JWSRenewalInfoDecodedPayload, type JWSTransactionDecodedPayload, type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { productById } from "@lingo/core";
import type { StoreEvent } from "./types";

/**
 * App Store 的交易、服务器通知(V2)→ 订阅事件。纯函数:输入是校验、解码后的数据,输出 core 的 SubEvent(带固定 id)。
 *
 * 设计要点:
 * - 每笔交易本身代表一件事:开始试用 / 购买(首次、重新订阅、升级)/ 续费(包括试用转正)。它的 id 只看交易 id,
 *   所以 App 上报的交易和苹果通知里的同一笔交易只算一次。
 * - 每条通知都带上它那笔交易的事件:如果之前的开通、续费通知丢了(服务器宕机超过苹果的重试期等),这里能补上;
 *   已经记过的按 id 去重。通知自己的变化(关闭自动续费、扣费失败、过期)id 看通知 id,重复发来也只算一次。
 * - 只认 core 的 PRODUCTS 里的商品(App Store Connect 的商品 id 必须和它一致);不支持家人共享。
 */

type SubscriptionTx = JWSTransactionDecodedPayload & {
  transactionId: string; originalTransactionId: string; productId: string; purchaseDate: number; expiresDate: number;
};

/** 字段齐全、而且是我们卖的自动续期订阅,才参与会员状态 */
function subscriptionTx(tx: JWSTransactionDecodedPayload | undefined): SubscriptionTx | null {
  if (!tx?.transactionId || !tx.originalTransactionId || !tx.productId || tx.purchaseDate === undefined || tx.expiresDate === undefined) return null;
  if (!productById(tx.productId)) return null;
  if (tx.type !== undefined && tx.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION) return null;
  // 家人共享的交易带的是购买者的账号标识;算进去的话,家人的变动(比如退出家庭)会改到购买者的会员上
  if (tx.inAppOwnershipType === InAppOwnershipType.FAMILY_SHARED) return null;
  return tx as SubscriptionTx;
}

/** 年度会员的 7 天免费试用在 App Store Connect 里是"推介促销优惠"(introductory offer),付款方式为"免费" */
const isFreeTrial = (tx: SubscriptionTx) =>
  tx.offerType === OfferType.INTRODUCTORY_OFFER &&
  (tx.offerDiscountType === OfferDiscountType.FREE_TRIAL || (tx.offerDiscountType === undefined && tx.price === 0));

/** 系统自动续费产生的交易(老数据没有 transactionReason 时:续费的交易 id 和原始交易 id 不同) */
const isRenewal = (tx: SubscriptionTx) =>
  tx.transactionReason !== undefined ? tx.transactionReason === TransactionReason.RENEWAL : tx.transactionId !== tx.originalTransactionId;

function transactionEvent(tx: SubscriptionTx): StoreEvent | null {
  // 已经升级成别的商品:这笔不再代表当前状态,升级后的商品有自己的交易
  if (tx.isUpgraded) return null;
  const at = new Date(tx.purchaseDate);
  const periodEnd = new Date(tx.expiresDate);
  const id = (type: string) => `apple:tx:${tx.transactionId}:${type}`;
  if (isRenewal(tx)) return { id: id("renewed"), type: "renewed", at, periodEnd, productId: tx.productId };
  if (isFreeTrial(tx)) return { id: id("start-trial"), type: "start-trial", productId: tx.productId, platform: "ios", at, periodEnd };
  return { id: id("purchase"), type: "purchase", productId: tx.productId, platform: "ios", at, periodEnd };
}

/** 退款、撤销按交易记一次(App 上报的已退款交易和苹果的退款通知是同一件事) */
const refundEvent = (tx: SubscriptionTx, fallbackAt: Date): StoreEvent => ({
  id: `apple:tx:${tx.transactionId}:refunded`, type: "refunded", at: tx.revocationDate !== undefined ? new Date(tx.revocationDate) : fallbackAt,
});

/** App 上报的交易(StoreKit 2 的 jwsRepresentation,校验解码后) → 事件 */
export function appleTransactionEvents(payload: JWSTransactionDecodedPayload): StoreEvent[] {
  const tx = subscriptionTx(payload);
  const base = tx && transactionEvent(tx);
  if (!tx || !base) return [];
  return tx.revocationDate !== undefined ? [base, refundEvent(tx, new Date(tx.revocationDate))] : [base];
}

/** App Store 服务器通知 V2(signedPayload 及其中的交易、续订信息,校验解码后) → 事件 */
export function appleNotificationEvents(
  n: ResponseBodyV2DecodedPayload, txPayload?: JWSTransactionDecodedPayload, renewal?: JWSRenewalInfoDecodedPayload,
): StoreEvent[] {
  const tx = subscriptionTx(txPayload);
  if (!tx || !n.notificationUUID) return [];
  const at = new Date(n.signedDate ?? tx.signedDate ?? tx.purchaseDate);
  const id = (type: string) => `apple:n:${n.notificationUUID}:${type}`;
  const base = transactionEvent(tx);
  const out: StoreEvent[] = base ? [base] : [];
  const renewOn = renewal?.autoRenewStatus === undefined ? undefined : renewal.autoRenewStatus === AutoRenewStatus.ON;
  const autoRenew = (on: boolean): StoreEvent => ({
    id: id("auto-renew"), type: "auto-renew", on, at, ...(renewal?.autoRenewProductId ? { productId: renewal.autoRenewProductId } : {}),
  });

  switch (n.notificationType) {
    case NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS:
      // 用户在系统设置里关闭 / 重新打开了自动续费
      return [...out, autoRenew(n.subtype ? n.subtype === Subtype.AUTO_RENEW_ENABLED : renewOn ?? true)];
    case NotificationTypeV2.DID_CHANGE_RENEWAL_PREF:
    case NotificationTypeV2.OFFER_REDEEMED:
      // 升级立即生效(通知里的交易就是新商品的购买);降级、不同时长的换档下一期才生效,只改"下一期续费的商品"。
      // 没有子类型的 DID_CHANGE_RENEWAL_PREF 是用户撤销了降级。
      if (n.subtype === Subtype.UPGRADE || n.subtype === Subtype.INITIAL_BUY || n.subtype === Subtype.RESUBSCRIBE) return out;
      return renewal ? [...out, autoRenew(renewOn ?? true)] : out;
    case NotificationTypeV2.DID_FAIL_TO_RENEW: {
      // 扣费失败:有宽限期(App Store Connect 里开启"账单宽限期")就照常使用到宽限期结束,没有就暂停会员、苹果继续重试扣费
      const graceEnd = n.subtype === Subtype.GRACE_PERIOD && renewal?.gracePeriodExpiresDate !== undefined ? new Date(renewal.gracePeriodExpiresDate) : undefined;
      return [...out, { id: id("billing-failed"), type: "billing-failed", at, ...(graceEnd ? { graceEnd } : {}) }];
    }
    case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
      // 宽限期结束还没扣上:苹果继续重试(最长 60 天),这期间不再是会员
      return [...out, { id: id("billing-failed"), type: "billing-failed", at }];
    case NotificationTypeV2.EXPIRED:
      // 用户取消后到期、重试扣费失败、不同意涨价、商品下架
      return [...out, { id: id("expired"), type: "expired", at }];
    case NotificationTypeV2.REFUND:
    case NotificationTypeV2.REVOKE:
      return [...out, refundEvent(tx, at)];
    case NotificationTypeV2.REFUND_REVERSED:
      // 苹果撤回了退款:会员恢复到这笔交易的到期时间
      return [...out, { id: id("renewed"), type: "renewed", at, periodEnd: new Date(tx.expiresDate), productId: tx.productId },
        ...(renewOn === undefined ? [] : [autoRenew(renewOn)])];
    case NotificationTypeV2.RENEWAL_EXTENDED:
      // 应我们的请求(客服补偿等)延长了这一期;不是付费续费,raw 里能看出来
      return [...out, { id: id("renewed"), type: "renewed", at, periodEnd: new Date(tx.expiresDate), productId: tx.productId }];
    default:
      // SUBSCRIBED、DID_RENEW:交易本身就是开通 / 续费。
      // 其他(PRICE_INCREASE、REFUND_DECLINED、CONSUMPTION_REQUEST、TEST……)不改变会员状态,只带上交易本身(已记过的会去重)
      return out;
  }
}
