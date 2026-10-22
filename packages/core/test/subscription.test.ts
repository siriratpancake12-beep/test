import { describe, expect, it } from "vitest";
import { applySubEvent, eventsFromServer, isPremium, renewalReminder, type SubEvent, type Subscription } from "../src/subscription";

const t0 = new Date("2026-11-01T12:00:00Z");
const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const apply = (events: SubEvent[], from: Subscription | null = null) => events.reduce<Subscription | null>((s, e) => applySubEvent(s, e), from);

describe("商店事件(向后兼容的扩展)", () => {
  it("商店确认的试用:以商店的到期时间为准;资格由商店判断,本地用过试用也照样记录", () => {
    const s = applySubEvent(null, { type: "start-trial", productId: "premium_yearly", platform: "ios", at: t0, periodEnd: day(7.5) })!;
    expect(s).toMatchObject({ status: "trial", trialUsed: true, autoRenew: true, periodEnd: day(7.5).toISOString() });
    const used: Subscription = { ...s, status: "expired", autoRenew: false, reminders: ["x@5"] };
    const again = applySubEvent(used, { type: "start-trial", productId: "premium_yearly", platform: "ios", at: day(30), periodEnd: day(37) })!;
    expect(again).toMatchObject({ status: "trial", periodEnd: day(37).toISOString(), reminders: ["x@5"] });
    // 不带 periodEnd 的(App 本机模拟)还是老规则:用过就不再给
    expect(applySubEvent(used, { type: "start-trial", productId: "premium_yearly", platform: "ios", at: day(30) })).toBe(used);
  });

  it("降级:下一期才换商品,扣费提醒按下一期的价格写;续费时生效", () => {
    let s = apply([{ type: "purchase", productId: "premium_yearly", platform: "ios", at: t0, periodEnd: day(365) }]);
    s = applySubEvent(s, { type: "auto-renew", on: true, at: day(10), productId: "premium_monthly" });
    expect(s).toMatchObject({ productId: "premium_yearly", renewProductId: "premium_monthly", autoRenew: true });
    const r = renewalReminder(s, day(362))!;
    expect(r).toMatchObject({ kind: "renewal", priceCny: 45 });
    expect(r.zh).toContain("年度会员将在 3 天后");
    expect(r.zh).toContain("之后自动续费月度会员 ¥45/月");
    // 改回原来的商品:取消降级
    expect(applySubEvent(s, { type: "auto-renew", on: true, at: day(11), productId: "premium_yearly" })?.renewProductId).toBeUndefined();
    // 续费时商品换成月度
    s = applySubEvent(s, { type: "renewed", at: day(365), periodEnd: day(395), productId: "premium_monthly" })!;
    expect(s).toMatchObject({ productId: "premium_monthly", status: "active", periodEnd: day(395).toISOString() });
    expect(s.renewProductId).toBeUndefined();
    expect(renewalReminder(s, day(392))?.zh).toBe("你的月度会员将在 3 天后(2027-12-01)自动续费 ¥45。不想继续可以随时在系统设置里取消。");
  });

  it("不带新字段的事件行为不变", () => {
    let s = apply([{ type: "purchase", productId: "premium_yearly", platform: "ios", at: t0, periodEnd: day(365) }]);
    s = applySubEvent(s, { type: "auto-renew", on: false, at: day(1) })!;
    expect(s).toMatchObject({ autoRenew: false, productId: "premium_yearly" });
    s = applySubEvent(s, { type: "renewed", at: day(365), periodEnd: day(730) })!;
    expect(s).toMatchObject({ productId: "premium_yearly", periodEnd: day(730).toISOString() });
  });
});

describe("App 按服务器记录对齐本地状态", () => {
  const server = (over: Partial<Subscription>): Subscription => ({
    productId: "premium_yearly", platform: "ios", status: "active", periodEnd: day(365).toISOString(),
    autoRenew: true, trialUsed: true, reminders: [], ...over,
  });
  const cases: Subscription[] = [
    server({ status: "trial", periodEnd: day(7).toISOString() }),
    server({}),
    server({ autoRenew: false }),
    server({ renewProductId: "premium_monthly" }),
    server({ status: "grace", graceEnd: day(381).toISOString() }),
    server({ status: "billing-retry" }),
    server({ status: "expired", autoRenew: false }),
    server({ status: "revoked", autoRenew: false }),
    server({ productId: "premium_monthly", trialUsed: false, periodEnd: day(30).toISOString() }),
  ];
  const locals: (Subscription | null)[] = [
    null,
    // 开发模式模拟开通的本地记录
    { productId: "premium_monthly", platform: "ios", status: "active", periodEnd: day(30).toISOString(), autoRenew: true, trialUsed: false, reminders: ["old@5"] },
    { productId: "premium_yearly", platform: "ios", status: "trial", periodEnd: day(3).toISOString(), autoRenew: true, trialUsed: true, reminders: [] },
  ];

  it("不管本地现在是什么,应用之后都和服务器一致(提醒记录保留)", () => {
    for (const s of cases) {
      for (const local of locals) {
        const next = apply(eventsFromServer(s, local, day(1)), local)!;
        const { reminders, ...rest } = next;
        const { reminders: _, ...want } = s;
        expect(rest, `${s.status} ← ${local?.status ?? "null"}`).toMatchObject(want);
        expect(rest.renewProductId).toBe(s.renewProductId);
        expect(reminders).toEqual(local?.reminders ?? []);
        expect(isPremium(next, day(2))).toBe(isPremium(s, day(2)));
      }
    }
  });

  it("已经一致就不产生事件;服务器没有记录时让本地有效的记录过期", () => {
    const s = cases[1]!;
    expect(eventsFromServer(s, s, day(1))).toEqual([]);
    expect(eventsFromServer(s, { ...s, reminders: ["a@5"] }, day(1))).toEqual([]);
    expect(eventsFromServer(null, locals[1], day(1))).toEqual([{ type: "expired", at: day(1) }]);
    expect(eventsFromServer(null, { ...locals[1]!, status: "expired" }, day(1))).toEqual([]);
    expect(eventsFromServer(null, null, day(1))).toEqual([]);
    // 不知道本地状态时给完整事件
    expect(eventsFromServer(s, undefined, day(1)).map((e) => e.type)).toEqual(["purchase", "auto-renew"]);
  });
});
