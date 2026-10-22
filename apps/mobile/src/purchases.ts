import { Platform } from "react-native";
import { productById, type Platform as SubPlatform, type SubEvent } from "@lingo/core";

/**
 * 购买会员。
 *
 * ⚠️ 现在是开发版:不连接任何商店、不会扣钱,只在本机模拟开通,用来把付费流程走通、测试界面。
 * 正式版要做的(需要负责人先注册苹果开发者账号、在 App Store Connect 建好订阅商品):
 * - iOS:StoreKit 2 苹果内购;服务器接 App Store Server Notifications,以服务器记录为准
 * - 安卓:各商店的支付 SDK / 微信支付、支付宝;同样由服务器校验
 */
export const DEV_PURCHASES = true;

const platform: SubPlatform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
const PERIOD_DAYS = { month: 30, year: 365 } as const;

export async function startTrial(productId: string): Promise<SubEvent[]> {
  return [{ type: "start-trial", productId, platform, at: new Date() }];
}

export async function buy(productId: string): Promise<SubEvent[]> {
  const p = productById(productId);
  if (!p) return [];
  const at = new Date();
  return [{ type: "purchase", productId, platform, at, periodEnd: new Date(at.getTime() + PERIOD_DAYS[p.period] * 86_400_000) }];
}

/** 恢复购买(换手机、重装后)。开发版没有商店记录,返回空。 */
export async function restore(): Promise<SubEvent[]> {
  return [];
}

/** 系统的订阅管理页(取消自动续费在这里) */
export const manageSubscriptionsUrl =
  Platform.OS === "ios" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions";
