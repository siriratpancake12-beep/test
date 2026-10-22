import {
  AutoRenewStatus, Environment, InAppOwnershipType, OfferDiscountType, OfferType, TransactionReason, Type,
  type JWSRenewalInfoDecodedPayload, type JWSTransactionDecodedPayload, type NotificationTypeV2, type ResponseBodyV2DecodedPayload, type Subtype,
} from "@apple/app-store-server-library";

/** 测试用的苹果数据(解码后的样子),字段和真实数据一致。默认:沙盒、中国区、年度会员首次购买。 */
export const BUNDLE_ID = "com.example.lingocn";
export const T0 = Date.parse("2026-11-01T12:00:00Z");
export const DAY = 86_400_000;
export const at = (days: number) => T0 + days * DAY;

export function appleTx(over: Partial<JWSTransactionDecodedPayload> = {}): JWSTransactionDecodedPayload {
  return {
    transactionId: "2000000001", originalTransactionId: "2000000001", webOrderLineItemId: "2000000000001",
    bundleId: BUNDLE_ID, productId: "premium_yearly", subscriptionGroupIdentifier: "21500000",
    purchaseDate: at(0), originalPurchaseDate: at(0), expiresDate: at(365), quantity: 1,
    type: Type.AUTO_RENEWABLE_SUBSCRIPTION, inAppOwnershipType: InAppOwnershipType.PURCHASED, signedDate: at(0),
    environment: Environment.SANDBOX, transactionReason: TransactionReason.PURCHASE,
    storefront: "CHN", storefrontId: "143465", price: 298000, currency: "CNY",
    ...over,
  };
}

/** 年度会员首次购买,带 7 天免费试用(推介促销优惠) */
export const trialTx = (over: Partial<JWSTransactionDecodedPayload> = {}) =>
  appleTx({ offerType: OfferType.INTRODUCTORY_OFFER, offerDiscountType: OfferDiscountType.FREE_TRIAL, offerPeriod: "P1W", price: 0, expiresDate: at(7), ...over });

/** 自动续费产生的交易 */
export const renewalTx = (transactionId: string, fromDay: number, toDay: number, over: Partial<JWSTransactionDecodedPayload> = {}) =>
  appleTx({ transactionId, transactionReason: TransactionReason.RENEWAL, purchaseDate: at(fromDay), expiresDate: at(toDay), signedDate: at(fromDay), ...over });

export function appleRenewal(over: Partial<JWSRenewalInfoDecodedPayload> = {}): JWSRenewalInfoDecodedPayload {
  return {
    originalTransactionId: "2000000001", autoRenewProductId: "premium_yearly", productId: "premium_yearly",
    autoRenewStatus: AutoRenewStatus.ON, signedDate: at(0), environment: Environment.SANDBOX,
    recentSubscriptionStartDate: at(0), renewalDate: at(365), renewalPrice: 298000, currency: "CNY",
    ...over,
  };
}

let seq = 0;
export function appleNotification(type: NotificationTypeV2, subtype?: Subtype, signedDay = 0, uuid?: string): ResponseBodyV2DecodedPayload {
  return {
    notificationType: type, ...(subtype ? { subtype } : {}), notificationUUID: uuid ?? `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    version: "2.0", signedDate: at(signedDay),
  };
}

// 服务器的测试也用这些(services/api 不直接依赖苹果的库)
export { NotificationTypeV2, Subtype } from "@apple/app-store-server-library";
export type { JWSRenewalInfoDecodedPayload, JWSTransactionDecodedPayload, ResponseBodyV2DecodedPayload };
