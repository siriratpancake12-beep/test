import Constants from "expo-constants";
import * as Iap from "expo-iap";
import { useEffect, useRef } from "react";
import { Alert, AppState, Platform } from "react-native";
import {
  eventsFromServer, productById, PRODUCTS, ROUTES, SubscriptionRes,
  type Platform as SubPlatform, type Product, type SubEvent, type Subscription,
} from "@lingo/core";
import { api, ApiFailure, getToken } from "./api";
import { currentUserId } from "./auth";
import { personalInfoAllowed } from "./privacy";
import { useStore } from "./store";

/**
 * 购买会员。两种模式:
 *
 * - **真实内购(iOS)**:app.json 的 extra.iapEnabled 为 true、平台是 iOS、并且已登录时。用 StoreKit 2(expo-iap)购买,
 *   买完把交易交给服务器校验(POST ROUTES.appleTransaction),服务器确认后才 finishTransaction。会员以服务器记录为准:
 *   以后的续费、退款、过期由苹果通知服务器,App 用 PurchaseSync / refreshSubscription 跟服务器对齐。
 * - **开发模式**(其他情况):不连接任何商店、不会扣钱,只在本机模拟开通,用来走通付费流程、测试界面。
 *
 * 价格写清楚:付费页按 core 的 PRODUCTS 显示人民币价格;App Store 的实际价格不一样(比如不是中国区的 Apple ID)、
 * 或者这个 Apple ID 已经用过免费试用时,扣钱之前先弹窗说明。
 *
 * 安卓暂不接支付(国内安卓手机大多没有谷歌服务),方案见 docs/08-支付接入.md。网页版见 purchases.web.ts(只有开发模式)。
 */

const IAP_ENABLED = ((Constants.expoConfig?.extra ?? {}) as { iapEnabled?: boolean }).iapEnabled === true;

/** 这个版本没有接真实内购(付费页据此显示"开发模式:不会真实扣费") */
export const DEV_PURCHASES = !(IAP_ENABLED && Platform.OS === "ios");

/**
 * 现在是否走真实内购:接了内购的 iOS 版本,同意了隐私政策,并且已登录(交易要对应到账号,服务器校验也要登录)。
 * 没同意隐私政策(基本功能模式)时连 App Store 都不连。
 */
export const storePurchasesEnabled = () => !DEV_PURCHASES && personalInfoAllowed() && !!getToken();

/** 购买没完成:用户取消(cancelled)、等待确认(pending,比如家长同意)、买不了(unavailable)、其他(failed)。除了取消,都已经弹窗告诉用户了 */
export class PurchaseFailure extends Error {
  constructor(readonly code: "cancelled" | "pending" | "unavailable" | "failed", message: string) {
    super(message);
    this.name = "PurchaseFailure";
  }
}

const platform: SubPlatform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
const PERIOD_DAYS = { month: 30, year: 365 } as const;
const unit = (p: Product) => (p.period === "year" ? "年" : "月");

/** 开始年度会员的免费试用。真实内购时就是购买年度会员:7 天试用是苹果的推介促销优惠,符合条件自动生效 */
export async function startTrial(productId: string): Promise<SubEvent[]> {
  if (storePurchasesEnabled()) return storeBuy(productId, true);
  devNotice();
  return [{ type: "start-trial", productId, platform, at: new Date() }];
}

export async function buy(productId: string): Promise<SubEvent[]> {
  if (storePurchasesEnabled()) return storeBuy(productId, false);
  const p = productById(productId);
  if (!p) return [];
  devNotice();
  const at = new Date();
  return [{ type: "purchase", productId, platform, at, periodEnd: new Date(at.getTime() + PERIOD_DAYS[p.period] * 86_400_000) }];
}

/** 恢复购买(换手机、重装、换了账号后)。找不到有效的会员返回空数组;开发模式没有商店记录,也返回空 */
export async function restore(): Promise<SubEvent[]> {
  if (!storePurchasesEnabled()) return [];
  return withAlert("恢复购买没有完成", async () => {
    await connect();
    // 同步苹果的购买记录(可能要输入 Apple ID 密码,所以只在用户点"恢复购买"时做);失败也不要紧,本机的记录还能读
    await Iap.restorePurchases().catch((e: unknown) => console.warn("同步 App Store 购买记录失败", e));
    const purchases = (await Iap.getAvailablePurchases({ onlyIncludeActiveItemsIOS: true })).filter((p) => productById(p.productId));
    let res: SubRes | null = null;
    let foreign: string | null = null;
    for (const p of purchases) {
      try {
        res = await verifyAndFinish(p);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 403) foreign = e.message;
        else throw e;
      }
    }
    // 本机没有记录(比如换了 Apple ID),服务器可能已经从苹果的通知里知道了
    if (!res?.premium) res = await serverSubscription();
    if (res.premium && res.subscription) return eventsFromServer(res.subscription);
    if (foreign) throw new PurchaseFailure("failed", foreign);
    return [];
  });
}

/** 系统的订阅管理页(取消自动续费在这里) */
export const manageSubscriptionsUrl =
  Platform.OS === "ios" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions";

export interface StoreOffer {
  /** App Store 显示的价格(用户所在地区的货币,比如 "¥298.00") */
  displayPrice: string;
  currency: string;
  price: number | null;
  /** 这个 Apple ID 还能不能免费试用;不知道时为 null */
  trialEligible: boolean | null;
}

/** App Store 上各会员的实际价格和试用资格,付费页可以用来显示(以 App Store 为准)。没接真实内购、没同意隐私政策时返回空对象 */
export async function storeOffers(): Promise<Record<string, StoreOffer>> {
  if (DEV_PURCHASES || !personalInfoAllowed()) return {};
  await connect();
  const out: Record<string, StoreOffer> = {};
  for (const item of (await Iap.fetchProducts({ skus: PRODUCTS.map((p) => p.id), type: "subs" })) ?? []) {
    const p = productById(item.id);
    if (!p || item.type !== "subs" || item.platform !== "ios") continue;
    const group = item.subscriptionGroupIdIOS;
    const trialEligible = p.trialDays && group ? await Iap.isEligibleForIntroOfferIOS(group).catch(() => null) : null;
    out[p.id] = { displayPrice: item.displayPrice, currency: item.currency, price: item.price ?? null, trialEligible };
  }
  return out;
}

/** 按服务器记录对齐本地会员状态(启动、回到前台时)。传入本地现在的状态,已经一致就返回空数组。不是真实内购模式时什么也不做 */
export async function refreshSubscription(local?: Subscription | null): Promise<SubEvent[]> {
  if (!storePurchasesEnabled()) return [];
  return eventsFromServer((await serverSubscription()).subscription, local);
}

/** App 开着时到来、并经服务器确认的交易(自动续费、家长批准后的购买、上次没处理完的)→ 回调事件。返回取消监听的函数 */
export function listenPurchases(onEvents: (events: SubEvent[]) => void): () => void {
  subscribers.add(onEvents);
  if (storePurchasesEnabled()) connect().catch((e: unknown) => console.warn("连接 App Store 失败", e));
  return () => {
    subscribers.delete(onEvents);
  };
}

/**
 * 让本地会员状态跟着服务器走:启动、登录(换账号)、回到前台时对齐一次,并处理 App 开着时到来的交易。
 * 登录也要对齐:换手机登录后会员马上恢复;退出登录、换账号时 store 已经清掉了本机的会员状态。
 * 要放在 StoreProvider 里面(_layout.tsx 的 <PurchaseSync />,同意隐私政策后才挂)。不是真实内购模式时什么也不做。
 */
export function usePurchaseSync(): void {
  const { ready, sub, applySub, user } = useStore();
  const local = useRef(sub);
  useEffect(() => {
    local.current = sub;
  }, [sub]);
  useEffect(() => {
    if (!ready) return;
    const sync = () => {
      if (!storePurchasesEnabled()) return;
      connect().catch((e: unknown) => console.warn("连接 App Store 失败", e));
      refreshSubscription(local.current)
        .then((events) => events.length && applySub(events))
        .catch((e: unknown) => console.warn("同步会员状态失败", e));
    };
    const stop = listenPurchases(applySub);
    sync();
    const appState = AppState.addEventListener("change", (s) => s === "active" && sync());
    return () => {
      stop();
      appState.remove();
    };
  }, [ready, applySub, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function PurchaseSync(): null {
  usePurchaseSync();
  return null;
}

// ---- 开发模式 ----

/** 接了内购的版本、但还没登录:说清楚这次只是模拟,不是真的买了 */
function devNotice() {
  if (!DEV_PURCHASES) Alert.alert("模拟开通", "还没有登录,这次只在本机模拟开通会员,不会扣费。登录后才能正式购买。");
}

// ---- 真实内购(iOS,StoreKit 2) ----

interface SubRes {
  subscription: Subscription | null;
  premium: boolean;
}

const subscribers = new Set<(events: SubEvent[]) => void>();
/** 正在进行的购买(同一时间只有一笔),等 StoreKit 把交易交回来 */
let pending: { sku: string; since: number; settle: (r: { purchase?: Iap.Purchase; error?: unknown }) => void } | null = null;
/** 交易 id → 正在进行的服务器校验(同一笔交易可能同时从购买结果和监听里来) */
const verifying = new Map<string, Promise<SubRes>>();
let listening = false;
let connecting: Promise<void> | null = null;

function connect(): Promise<void> {
  if (!listening) {
    listening = true;
    // 先注册监听再连接:一连上就可能收到上次没处理完的交易
    Iap.purchaseUpdatedListener((p) => void onPurchaseUpdated(p));
    Iap.purchaseErrorListener((e) => {
      if (pending && (!e.productId || e.productId === pending.sku)) pending.settle({ error: e });
    });
  }
  connecting ??= Iap.initConnection()
    .then((ok) => {
      if (!ok) throw new PurchaseFailure("unavailable", "连接不上 App Store,请稍后再试");
    })
    .catch((e: unknown) => {
      connecting = null;
      throw e;
    });
  return connecting;
}

/** 还在等确认(家长同意等)的交易没有凭证,确认后会作为新的交易再来 */
const delivered = (p: Iap.Purchase) => (p.purchaseState === "pending" ? { error: { code: Iap.ErrorCode.Pending } } : { purchase: p });

async function onPurchaseUpdated(p: Iap.Purchase) {
  // 正在买的那一笔(连上 App Store 时补发的旧交易时间更早,不算)
  if (pending && p.productId === pending.sku && p.transactionDate >= pending.since - 60_000) return pending.settle(delivered(p));
  // 后台到来的交易。没登录先不处理:交易没结束,下次启动 StoreKit 还会给
  if (!productById(p.productId) || p.purchaseState !== "purchased" || !storePurchasesEnabled()) return;
  try {
    const res = await verifyAndFinish(p);
    if (res.subscription) {
      const events = eventsFromServer(res.subscription);
      subscribers.forEach((fn) => fn(events));
    }
  } catch (e) {
    console.warn("后台确认购买失败,下次启动会再试", e);
  }
}

async function storeBuy(productId: string, trial: boolean): Promise<SubEvent[]> {
  const product = productById(productId);
  if (!product) return [];
  return withAlert("购买没有完成", async () => {
    const userId = appAccountToken();
    if (!userId) throw new PurchaseFailure("failed", "登录信息不完整,请退出后重新登录再购买");
    await connect();
    // 服务器上已经是会员(在别的设备上买过、试用已经转正但本机还没更新):直接同步,不重复购买
    const current = await serverSubscription();
    if (current.premium && current.subscription) return eventsFromServer(current.subscription);
    const item = await storeProduct(productId);
    if (!(await confirmTerms(product, item, trial))) throw new PurchaseFailure("cancelled", "已取消");
    const purchase = await requestOnce(productId, userId);
    let res: SubRes;
    try {
      res = await verifyAndFinish(purchase);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 403) throw new PurchaseFailure("failed", e.message);
      if (e instanceof ApiFailure && e.status === 400) throw new PurchaseFailure("failed", "付款已经完成,但服务器没能确认这笔购买。不会重复扣费,请联系客服处理。");
      throw new PurchaseFailure("failed", "付款已经完成,但会员还没确认(网络或服务器暂时有问题)。不会重复扣费,稍后会自动开通;也可以在付费页点「恢复购买」。");
    }
    if (!res.subscription) throw new PurchaseFailure("failed", "付款已经完成,但会员还没开通。请稍后在付费页点「恢复购买」,或联系客服。");
    return eventsFromServer(res.subscription);
  });
}

async function storeProduct(sku: string): Promise<Iap.ProductSubscriptionIOS> {
  const list = (await Iap.fetchProducts({ skus: [sku], type: "subs" })) ?? [];
  for (const item of list) {
    if (item.id === sku && item.type === "subs" && item.platform === "ios") return item;
  }
  throw new PurchaseFailure("unavailable", "暂时买不了这个会员,请稍后再试");
}

/** 付费页写的条件和 App Store 实际的不一样时,扣钱之前先说清楚,让用户决定 */
async function confirmTerms(p: Product, item: Iap.ProductSubscriptionIOS, trial: boolean): Promise<boolean> {
  const notes: string[] = [];
  if (trial && item.subscriptionGroupIdIOS) {
    // 试用资格由苹果按 Apple ID 判断(同一个订阅群组只能试用一次)
    const eligible = await Iap.isEligibleForIntroOfferIOS(item.subscriptionGroupIdIOS).catch(() => true);
    if (!eligible) notes.push("你的 Apple ID 已经用过免费试用,这次开通会立即扣费。");
  }
  if (item.currency !== "CNY" || (item.price != null && Math.abs(item.price - p.priceCny) > 0.001)) {
    notes.push(`App Store 上的实际价格和这里写的 ¥${p.priceCny}/${unit(p)} 不一样,以 App Store 为准。`);
  }
  if (!notes.length) return true;
  return new Promise((resolve) =>
    Alert.alert("开通前请确认", `${notes.join("\n")}\n价格:${item.displayPrice}/${unit(p)},到期自动续费,随时可以在系统设置里取消。`, [
      { text: "先不开通", style: "cancel", onPress: () => resolve(false) },
      { text: "继续开通", onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}

/** 发起购买,等 StoreKit 把交易交回来(从购买结果或监听里,哪个先到用哪个) */
function requestOnce(sku: string, appAccountToken: string): Promise<Iap.Purchase> {
  if (pending) return Promise.reject(new PurchaseFailure("failed", "上一笔购买还没完成,请稍等"));
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: { purchase?: Iap.Purchase; error?: unknown }) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (pending?.settle === settle) pending = null;
      if (r.purchase) resolve(r.purchase);
      else reject(toFailure(r.error));
    };
    pending = { sku, since: Date.now(), settle };
    // appAccountToken = 用户 id:服务器靠它把交易和苹果的通知对应到这个账号
    Iap.requestPurchase({ request: { apple: { sku, appAccountToken } }, type: "subs" })
      .then((r) => {
        const got = (Array.isArray(r) ? r : r ? [r] : []).find((x) => x.productId === sku);
        if (got) return settle(delivered(got));
        // 没有直接拿到交易:等监听;一直没有,说明在等确认(家长同意、银行验证),确认后会作为后台交易到来
        timer = setTimeout(() => settle({ error: { code: Iap.ErrorCode.Pending } }), 10_000);
      })
      .catch((error: unknown) => settle({ error }));
  });
}

/** 交给服务器校验,确认后结束交易。没确认的交易不结束:苹果每次启动都会再给,不会丢 */
function verifyAndFinish(p: Iap.Purchase): Promise<SubRes> {
  const key = ("transactionId" in p && p.transactionId) || p.id;
  let job = verifying.get(key);
  if (!job) {
    job = (async () => {
      if (!p.purchaseToken) throw new PurchaseFailure("failed", "没有拿到购买凭证,请稍后在付费页点「恢复购买」");
      const finish = () => Iap.finishTransaction({ purchase: p, isConsumable: false }).catch((e: unknown) => console.warn("结束交易失败,下次启动再试", e));
      let res: SubRes;
      try {
        res = toSubRes(await api("POST", ROUTES.appleTransaction, { signedTransaction: p.purchaseToken }));
      } catch (e) {
        // 凭证无效、属于别的账号:服务器不会认,结束掉免得每次启动重来(会员以服务器记录为准,苹果的通知也会到服务器)
        if (e instanceof ApiFailure && (e.status === 400 || e.status === 403)) await finish();
        throw e;
      }
      await finish();
      return res;
    })().finally(() => verifying.delete(key));
    verifying.set(key, job);
  }
  return job;
}

async function serverSubscription(): Promise<SubRes> {
  return toSubRes(await api("GET", ROUTES.subscription));
}

/** 校验服务器返回的格式。renewProductId(降级后下一期的商品,扣费提醒要用)接口约定里还没有,单独取出来 */
function toSubRes(data: unknown): SubRes {
  const parsed = SubscriptionRes.parse(data);
  const renew = (data as { subscription?: { renewProductId?: unknown } | null } | null)?.subscription?.renewProductId;
  const subscription = parsed.subscription && (typeof renew === "string" ? { ...parsed.subscription, renewProductId: renew } : parsed.subscription);
  return { subscription, premium: parsed.premium };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 当前登录的账号 id(账号模块提供)。苹果要求 appAccountToken 是 UUID,服务器的账号 id 正是 UUID */
function appAccountToken(): string | null {
  const id = getToken() ? currentUserId() : null;
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

function toFailure(e: unknown): PurchaseFailure {
  if (e instanceof PurchaseFailure) return e;
  if (e instanceof ApiFailure) return new PurchaseFailure("failed", e.message);
  if (Iap.isUserCancelledError(e)) return new PurchaseFailure("cancelled", "已取消");
  switch ((e as { code?: unknown } | null)?.code) {
    case Iap.ErrorCode.Pending:
    case Iap.ErrorCode.DeferredPayment:
      return new PurchaseFailure("pending", "购买正在等待确认(比如需要家长同意),确认后会自动开通会员。");
    case Iap.ErrorCode.NetworkError:
      return new PurchaseFailure("failed", "网络连接失败,请检查网络后再试");
    case Iap.ErrorCode.AlreadyOwned:
      return new PurchaseFailure("failed", "你已经订阅过了,可以点「恢复购买」");
    case Iap.ErrorCode.IapNotAvailable:
    case Iap.ErrorCode.BillingUnavailable:
    case Iap.ErrorCode.ItemUnavailable:
    case Iap.ErrorCode.SkuNotFound:
      return new PurchaseFailure("unavailable", "这台设备暂时买不了会员(可能关闭了 App 内购买),请稍后再试");
    default:
      return new PurchaseFailure("failed", "购买没有完成,请稍后再试");
  }
}

/** 出错时弹窗说明原因(用户自己取消的不弹),再抛出 PurchaseFailure,调用方不用再提示 */
async function withAlert<T>(title: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const f = toFailure(e);
    if (f.code !== "cancelled") Alert.alert(f.code === "pending" ? "等待确认" : title, f.message);
    throw f;
  }
}
