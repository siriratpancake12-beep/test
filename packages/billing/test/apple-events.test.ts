import { describe, expect, it } from "vitest";
import { AutoRenewStatus, InAppOwnershipType, NotificationTypeV2 as N, Subtype, Type } from "@apple/app-store-server-library";
import { isPremium, renewalReminder, type Subscription } from "@lingo/core";
import { appleNotificationEvents, appleTransactionEvents, applyStoreEvents, isStale, type StoreEvent } from "../src/index";
import { appleNotification, appleRenewal, appleTx, at, renewalTx, trialTx } from "./payloads";

const d = (days: number) => new Date(at(days));
const types = (evs: StoreEvent[]) => evs.map((e) => e.type);

describe("App 上报的交易 → 事件", () => {
  it("首次订阅带 7 天免费试用:开始试用,到期时间以苹果为准", () => {
    expect(appleTransactionEvents(trialTx())).toEqual([
      { id: "apple:tx:2000000001:start-trial", type: "start-trial", productId: "premium_yearly", platform: "ios", at: d(0), periodEnd: d(7) },
    ]);
  });

  it("首次订阅不带试用(月度会员)", () => {
    const tx = appleTx({ productId: "premium_monthly", expiresDate: at(30), price: 45000 });
    expect(appleTransactionEvents(tx)).toEqual([
      { id: "apple:tx:2000000001:purchase", type: "purchase", productId: "premium_monthly", platform: "ios", at: d(0), periodEnd: d(30) },
    ]);
  });

  it("续费的交易;老数据没有 transactionReason 时按交易 id 判断", () => {
    expect(appleTransactionEvents(renewalTx("2000000002", 7, 372))).toEqual([
      { id: "apple:tx:2000000002:renewed", type: "renewed", at: d(7), periodEnd: d(372), productId: "premium_yearly" },
    ]);
    expect(types(appleTransactionEvents(renewalTx("2000000002", 7, 372, { transactionReason: undefined })))).toEqual(["renewed"]);
  });

  it("已退款 / 撤销的交易:先开通(补上可能漏掉的),再撤销", () => {
    const evs = appleTransactionEvents(appleTx({ revocationDate: at(20), revocationReason: 0 }));
    expect(evs).toEqual([
      expect.objectContaining({ type: "purchase" }),
      { id: "apple:tx:2000000001:refunded", type: "refunded", at: d(20) },
    ]);
  });

  it("不参与会员状态的交易:已升级的旧交易、不认识的商品、家人共享、非订阅", () => {
    expect(appleTransactionEvents(appleTx({ isUpgraded: true }))).toEqual([]);
    expect(appleTransactionEvents(appleTx({ productId: "lifetime" }))).toEqual([]);
    expect(appleTransactionEvents(appleTx({ inAppOwnershipType: InAppOwnershipType.FAMILY_SHARED }))).toEqual([]);
    expect(appleTransactionEvents(appleTx({ type: Type.NON_CONSUMABLE }))).toEqual([]);
    expect(appleTransactionEvents(appleTx({ expiresDate: undefined }))).toEqual([]);
  });
});

describe("服务器通知 → 事件", () => {
  it("首次订阅(带试用 / 不带)、重新订阅:和 App 上报的同一笔交易 id 相同,只算一次", () => {
    expect(appleNotificationEvents(appleNotification(N.SUBSCRIBED, Subtype.INITIAL_BUY), trialTx(), appleRenewal()))
      .toEqual(appleTransactionEvents(trialTx()));
    expect(types(appleNotificationEvents(appleNotification(N.SUBSCRIBED, Subtype.INITIAL_BUY), appleTx(), appleRenewal()))).toEqual(["purchase"]);
    const re = appleTx({ transactionId: "2000000009", purchaseDate: at(400), expiresDate: at(765) });
    expect(appleNotificationEvents(appleNotification(N.SUBSCRIBED, Subtype.RESUBSCRIBE, 400), re)).toEqual([
      { id: "apple:tx:2000000009:purchase", type: "purchase", productId: "premium_yearly", platform: "ios", at: d(400), periodEnd: d(765) },
    ]);
  });

  it("续费(包括试用转正、扣费失败后补扣成功)", () => {
    expect(appleNotificationEvents(appleNotification(N.DID_RENEW, undefined, 7), renewalTx("2000000002", 7, 372))).toEqual([
      { id: "apple:tx:2000000002:renewed", type: "renewed", at: d(7), periodEnd: d(372), productId: "premium_yearly" },
    ]);
    expect(types(appleNotificationEvents(appleNotification(N.DID_RENEW, Subtype.BILLING_RECOVERY, 380), renewalTx("2000000003", 380, 745)))).toEqual(["renewed"]);
  });

  it("扣费失败:有宽限期进入宽限期;没有就进入重试扣费;宽限期结束", () => {
    const n = appleNotification(N.DID_FAIL_TO_RENEW, Subtype.GRACE_PERIOD, 372, "n-grace");
    const evs = appleNotificationEvents(n, renewalTx("2000000002", 7, 372), appleRenewal({ gracePeriodExpiresDate: at(388), isInBillingRetryPeriod: true }));
    expect(evs).toEqual([
      expect.objectContaining({ id: "apple:tx:2000000002:renewed" }),
      { id: "apple:n:n-grace:billing-failed", type: "billing-failed", at: d(372), graceEnd: d(388) },
    ]);
    const noGrace = appleNotificationEvents(appleNotification(N.DID_FAIL_TO_RENEW, undefined, 372, "n-retry"), renewalTx("2000000002", 7, 372), appleRenewal());
    expect(noGrace[1]).toEqual({ id: "apple:n:n-retry:billing-failed", type: "billing-failed", at: d(372) });
    const ended = appleNotificationEvents(appleNotification(N.GRACE_PERIOD_EXPIRED, undefined, 388, "n-ge"), renewalTx("2000000002", 7, 372), appleRenewal());
    expect(ended[1]).toEqual({ id: "apple:n:n-ge:billing-failed", type: "billing-failed", at: d(388) });
  });

  it("过期(用户取消后到期、重试扣费失败等)", () => {
    const evs = appleNotificationEvents(appleNotification(N.EXPIRED, Subtype.VOLUNTARY, 365, "n-exp"), appleTx(), appleRenewal({ autoRenewStatus: AutoRenewStatus.OFF }));
    expect(types(evs)).toEqual(["purchase", "expired"]);
    expect(evs[1]).toEqual({ id: "apple:n:n-exp:expired", type: "expired", at: d(365) });
  });

  it("关闭 / 打开自动续费", () => {
    const off = appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_DISABLED, 3, "n-off"), trialTx(), appleRenewal({ autoRenewStatus: AutoRenewStatus.OFF }));
    expect(off[1]).toEqual({ id: "apple:n:n-off:auto-renew", type: "auto-renew", on: false, at: d(3), productId: "premium_yearly" });
    const on = appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_ENABLED, 4, "n-on"), trialTx(), appleRenewal());
    expect(on[1]).toMatchObject({ type: "auto-renew", on: true });
  });

  it("退款;撤销(家人共享的不算,自己买的按退款处理);退款被撤回", () => {
    const refunded = trialTx({ revocationDate: at(3) });
    const refund = appleNotificationEvents(appleNotification(N.REFUND, undefined, 3), refunded, appleRenewal());
    expect(refund).toEqual(appleTransactionEvents(refunded));
    const revoke = appleTx({ revocationDate: at(50) });
    expect(types(appleNotificationEvents(appleNotification(N.REVOKE, undefined, 50), revoke))).toEqual(["purchase", "refunded"]);
    expect(appleNotificationEvents(appleNotification(N.REVOKE, undefined, 50), appleTx({ revocationDate: at(50), inAppOwnershipType: InAppOwnershipType.FAMILY_SHARED }))).toEqual([]);
    const reversed = appleNotificationEvents(appleNotification(N.REFUND_REVERSED, undefined, 60, "n-rr"), appleTx(), appleRenewal());
    expect(reversed.slice(1)).toEqual([
      { id: "apple:n:n-rr:renewed", type: "renewed", at: d(60), periodEnd: d(365), productId: "premium_yearly" },
      { id: "apple:n:n-rr:auto-renew", type: "auto-renew", on: true, at: d(60), productId: "premium_yearly" },
    ]);
  });

  it("升级立即生效;降级下一期生效;撤销降级", () => {
    const upgraded = appleTx({ transactionId: "2000000005", productId: "premium_yearly", purchaseDate: at(10), expiresDate: at(375) });
    expect(appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_PREF, Subtype.UPGRADE, 10), upgraded, appleRenewal())).toEqual([
      { id: "apple:tx:2000000005:purchase", type: "purchase", productId: "premium_yearly", platform: "ios", at: d(10), periodEnd: d(375) },
    ]);
    const down = appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_PREF, Subtype.DOWNGRADE, 20, "n-down"), appleTx(), appleRenewal({ autoRenewProductId: "premium_monthly" }));
    expect(down[1]).toEqual({ id: "apple:n:n-down:auto-renew", type: "auto-renew", on: true, at: d(20), productId: "premium_monthly" });
    const undo = appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_PREF, undefined, 21), appleTx(), appleRenewal());
    expect(undo[1]).toMatchObject({ type: "auto-renew", productId: "premium_yearly" });
  });

  it("不改变会员状态的通知只带交易本身;测试通知什么也没有", () => {
    expect(types(appleNotificationEvents(appleNotification(N.PRICE_INCREASE, Subtype.PENDING), appleTx(), appleRenewal()))).toEqual(["purchase"]);
    expect(types(appleNotificationEvents(appleNotification(N.REFUND_DECLINED), appleTx()))).toEqual(["purchase"]);
    expect(appleNotificationEvents(appleNotification(N.TEST))).toEqual([]);
  });

  it("同一条通知重复发来,事件 id 不变", () => {
    const n = appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_DISABLED, 3);
    expect(appleNotificationEvents(n, trialTx(), appleRenewal())).toEqual(appleNotificationEvents({ ...n }, trialTx(), appleRenewal()));
  });
});

describe("事件 → 会员状态(配合 core 的状态机)", () => {
  /** 和服务器一样:按 id 去重,过时的不应用 */
  function player() {
    const seen = new Set<string>();
    let sub: Subscription | null = null;
    return {
      get sub() { return sub; },
      play(events: StoreEvent[], periodEnd: number, now: number) {
        const fresh = events.filter((e) => !seen.has(e.id));
        fresh.forEach((e) => seen.add(e.id));
        sub = applyStoreEvents(sub, fresh, new Date(periodEnd), new Date(now));
        return sub;
      },
    };
  }

  it("试用 → 关闭/打开自动续费 → 转正 → 扣费失败、宽限期 → 补扣成功 → 旧通知乱序到达 → 退款", () => {
    const p = player();
    p.play(appleTransactionEvents(trialTx()), at(7), at(0));
    expect(p.sub).toMatchObject({ status: "trial", trialUsed: true, autoRenew: true });
    expect(isPremium(p.sub, d(6))).toBe(true);
    // 苹果的开通通知和 App 上报是同一件事
    const before = p.sub;
    p.play(appleNotificationEvents(appleNotification(N.SUBSCRIBED, Subtype.INITIAL_BUY), trialTx(), appleRenewal()), at(7), at(0));
    expect(p.sub).toBe(before);

    p.play(appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_DISABLED, 3), trialTx(), appleRenewal({ autoRenewStatus: 0 })), at(7), at(3));
    expect(renewalReminder(p.sub, d(3))).toBeNull();
    p.play(appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_ENABLED, 4), trialTx(), appleRenewal()), at(7), at(4));
    expect(renewalReminder(p.sub, d(4))).toMatchObject({ kind: "trial-ending", priceCny: 298 });

    const year1 = renewalTx("2000000002", 7, 372);
    const renew1 = appleNotificationEvents(appleNotification(N.DID_RENEW, undefined, 7), year1);
    p.play(renew1, at(372), at(7));
    expect(p.sub).toMatchObject({ status: "active", periodEnd: d(372).toISOString() });

    p.play(appleNotificationEvents(appleNotification(N.DID_FAIL_TO_RENEW, Subtype.GRACE_PERIOD, 372), year1, appleRenewal({ gracePeriodExpiresDate: at(388) })), at(372), at(372));
    expect(p.sub?.status).toBe("grace");
    expect(isPremium(p.sub, d(380))).toBe(true);
    p.play(appleNotificationEvents(appleNotification(N.GRACE_PERIOD_EXPIRED, undefined, 388), year1, appleRenewal()), at(372), at(388));
    expect(p.sub?.status).toBe("billing-retry");
    expect(isPremium(p.sub, d(389))).toBe(false);

    const year2 = renewalTx("2000000003", 390, 755);
    p.play(appleNotificationEvents(appleNotification(N.DID_RENEW, Subtype.BILLING_RECOVERY, 390), year2), at(755), at(390));
    expect(p.sub).toMatchObject({ status: "active", periodEnd: d(755).toISOString() });
    expect(p.sub?.graceEnd).toBeUndefined();

    // 第一年的扣费失败通知被苹果重发、又晚到了一条第一年的退款:都属于旧的一期,不改现在的状态
    const now = p.sub;
    p.play(appleNotificationEvents(appleNotification(N.DID_FAIL_TO_RENEW, undefined, 372), year1, appleRenewal()), at(372), at(391));
    p.play(appleNotificationEvents(appleNotification(N.REFUND, undefined, 391), { ...year1, revocationDate: at(391) }), at(372), at(391));
    expect(p.sub).toBe(now);

    // 这一期退款:会员撤销
    p.play(appleNotificationEvents(appleNotification(N.REFUND, undefined, 400), { ...year2, revocationDate: at(400) }), at(755), at(400));
    expect(p.sub?.status).toBe("revoked");
    expect(isPremium(p.sub, d(401))).toBe(false);

    // 退款后改买月度(周期比原来的年度短)也要生效
    const monthly = appleTx({ transactionId: "2000000010", productId: "premium_monthly", purchaseDate: at(410), expiresDate: at(440) });
    p.play(appleTransactionEvents(monthly), at(440), at(410));
    expect(p.sub).toMatchObject({ status: "active", productId: "premium_monthly", periodEnd: d(440).toISOString() });
  });

  it("降级在下一期生效:提醒按下一期的商品和价格", () => {
    const p = player();
    p.play(appleTransactionEvents(appleTx()), at(365), at(0));
    p.play(appleNotificationEvents(appleNotification(N.DID_CHANGE_RENEWAL_PREF, Subtype.DOWNGRADE, 30), appleTx(), appleRenewal({ autoRenewProductId: "premium_monthly" })), at(365), at(30));
    expect(p.sub).toMatchObject({ productId: "premium_yearly", renewProductId: "premium_monthly" });
    expect(renewalReminder(p.sub, d(362))).toMatchObject({ priceCny: 45 });
    p.play(appleNotificationEvents(appleNotification(N.DID_RENEW, undefined, 365), renewalTx("2000000002", 365, 395, { productId: "premium_monthly" })), at(395), at(365));
    expect(p.sub).toMatchObject({ productId: "premium_monthly", status: "active" });
    expect(p.sub?.renewProductId).toBeUndefined();
  });

  it("过期 / 撤销后:还没结束的新一期即使更短也生效,已经结束的旧一期算过时", () => {
    const ended: Subscription = { productId: "premium_yearly", platform: "ios", status: "expired", periodEnd: d(365).toISOString(), autoRenew: false, trialUsed: true, reminders: [] };
    expect(isStale(ended, d(380), d(370))).toBe(false);
    expect(isStale(ended, d(300), d(370))).toBe(true);
    expect(isStale({ ...ended, status: "revoked" }, d(340), d(330))).toBe(false);
    expect(isStale({ ...ended, status: "active" }, d(340), d(330))).toBe(true);
    expect(isStale(null, d(1), d(0))).toBe(false);
  });
});
