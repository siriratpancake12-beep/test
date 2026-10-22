import { productById, type SubEvent, type Subscription } from "@lingo/core";

/**
 * 网页版(给团队看界面、跑端到端测试)只有开发模式:不连接任何商店、不会扣钱,只在本机模拟开通。
 * 导出和 purchases.ts 保持一致(付费页等页面两边通用);不引入 expo-iap,网页打包用不到原生模块。
 */
export const DEV_PURCHASES = true;
export const storePurchasesEnabled = () => false;

export class PurchaseFailure extends Error {
  constructor(readonly code: "cancelled" | "pending" | "unavailable" | "failed", message: string) {
    super(message);
    this.name = "PurchaseFailure";
  }
}

const PERIOD_DAYS = { month: 30, year: 365 } as const;

export async function startTrial(productId: string): Promise<SubEvent[]> {
  return [{ type: "start-trial", productId, platform: "web", at: new Date() }];
}

export async function buy(productId: string): Promise<SubEvent[]> {
  const p = productById(productId);
  if (!p) return [];
  const at = new Date();
  return [{ type: "purchase", productId, platform: "web", at, periodEnd: new Date(at.getTime() + PERIOD_DAYS[p.period] * 86_400_000) }];
}

export async function restore(): Promise<SubEvent[]> {
  return [];
}

export const manageSubscriptionsUrl = "https://play.google.com/store/account/subscriptions";

export interface StoreOffer {
  displayPrice: string;
  currency: string;
  price: number | null;
  trialEligible: boolean | null;
}

export async function storeOffers(): Promise<Record<string, StoreOffer>> {
  return {};
}

export async function refreshSubscription(_local?: Subscription | null): Promise<SubEvent[]> {
  return [];
}

export function listenPurchases(_onEvents: (events: SubEvent[]) => void): () => void {
  return () => {};
}

export function usePurchaseSync(): void {}

export function PurchaseSync(): null {
  return null;
}
