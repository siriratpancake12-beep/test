import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import {
  applyStoreEvents, createAppleVerifier, isStale, loadAppleRootCertificates, StoreVerificationError, type AppStoreVerifier, type StoreEvent,
} from "@lingo/billing";
import { AppleTransactionReq, isPremium, ROUTES, type Subscription, type SubscriptionRes } from "@lingo/core";
import type { Deps } from "../app";
import { requireUser } from "../auth/session";
import type { Config } from "../config";
import type { Db } from "../db";
import {
  activeUserId, bindingOwner, claimOrphanEvents, deleteBoundSubscription, loadSubscription, lockOriginalTransaction, lockUserSubscription,
  recentAccountTokens, recordAppleNotification, recordEvents, recordRebind, saveSubscription,
} from "../db/billing";
import { HttpError } from "../errors";

/**
 * 订阅:查询会员状态、App 上报交易、App Store 服务器通知。负责人:billing。
 *
 * 以服务器记录为准:App 买完把交易交给这里校验;之后的续费、扣费失败、过期、退款都由苹果的服务器通知告诉我们。
 * 两条路可能同时到、乱序到、重复到,所以:事件按固定 id 只记一次、只应用一次;过时的数据不改状态;同一订阅、同一用户排队更新。
 *
 * 订阅归谁(换绑规则):一个苹果订阅(原始交易 id)同一时间只属于一个语途账号。
 * - 交易里的账号标识(购买时 App 传给苹果的用户 id)就是当前账号,或者订阅已经绑定在当前账号:是他的。
 * - 原来的主人已经注销(或者账号这一行已经没了):恢复购买时换绑到当前账号。交易是苹果签名的,证明当前的 Apple ID 拥有这个订阅。
 * - 原来的主人还在用:不悄悄换绑,回"这笔购买属于另一个语途账号"。
 * - 同一个 Apple ID 在另一个账号里重新买了(交易带的是这个账号的标识):谁付的钱归谁,订阅转过去。
 * 每次换绑都在 subscription_rebinds 记一行(只有 id),原来主人名下的这个订阅删掉,免得两个账号都是会员。
 * 苹果的通知不会记到已注销的账号上:找不到还在用的主人就先记下,等新账号恢复购买时一起补上。
 * 接入说明见 docs/08-支付接入.md。
 */

/**
 * 按配置创建 App Store 校验器;缺配置就返回 null(交易接口回 503"支付服务暂未开通")。
 * 苹果根证书放在 config.apple.rootCertsDir(环境变量 APPLE_ROOT_CERTS_DIR)指定的目录(不进仓库)。
 */
export function createAppStoreVerifier(config: Config): AppStoreVerifier | null {
  const a = config.apple;
  const off = (why: string) => {
    if (config.env !== "test") console.warn(`[支付] 苹果内购校验未开通:${why}`);
    return null;
  };
  if (a.environment === "LocalTesting") {
    // Xcode 本机 StoreKit 测试的数据不是苹果签的,官方库会跳过签名校验:生产环境绝不能用
    if (config.env === "production") return off("生产环境不能用 APPLE_ENVIRONMENT=LocalTesting");
    return createAppleVerifier({ bundleId: a.bundleId, environment: "LocalTesting", rootCertificates: [] });
  }
  const dir = a.rootCertsDir;
  if (!dir) return off("没有配置 APPLE_ROOT_CERTS_DIR(苹果根证书目录)");
  if (a.environment === "Production" && !a.appAppleId) return off("生产环境要配置 APPLE_APP_ID(App 的数字 id)");
  try {
    const rootCertificates = loadAppleRootCertificates(dir);
    if (!rootCertificates.length) return off(`${dir} 里没有证书文件(.cer)`);
    return createAppleVerifier({ bundleId: a.bundleId, environment: a.environment, appAppleId: a.appAppleId, rootCertificates });
  } catch (e) {
    return off(`读取苹果根证书失败(${dir}):${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 这个用户现在是不是会员(AI 老师、发音评测等模块用来判断额度)。签名不要改。
 */
export async function getPremium(deps: Deps, userId: string): Promise<boolean> {
  const { sub } = await loadSubscription(deps.db, userId);
  return isPremium(sub, deps.now());
}

const NotificationBody = z.object({ signedPayload: z.string().min(10) });
const disabled = () => new HttpError(503, "billing_disabled", "支付服务暂未开通");
const res = (sub: Subscription | null, now: Date): SubscriptionRes => ({ subscription: sub, premium: isPremium(sub, now) });

export function registerBilling(app: FastifyInstance, deps: Deps) {
  app.get(ROUTES.subscription, async (req): Promise<SubscriptionRes> => {
    const userId = await requireUser(req, deps.config);
    return res((await loadSubscription(deps.db, userId)).sub, deps.now());
  });

  /** App 买完(或恢复购买时)把 StoreKit 2 的交易(jwsRepresentation)交上来 */
  app.post(ROUTES.appleTransaction, async (req): Promise<SubscriptionRes> => {
    const userId = await requireUser(req, deps.config);
    const store = deps.appStore;
    if (!store) throw disabled();
    const { signedTransaction } = AppleTransactionReq.parse(req.body);
    const tx = await verified(req.log, () => store.verifyTransaction(signedTransaction));
    const item: StoreItem = {
      source: "apple-transaction", environment: tx.environment, originalTransactionId: tx.originalTransactionId,
      productId: tx.productId, periodEnd: tx.periodEnd, events: tx.events, raw: tx.raw,
    };
    const sub = await deps.db.transaction().execute(async (trx) => {
      const otid = tx.originalTransactionId;
      await lockOriginalTransaction(trx, otid);
      const me = userId.toLowerCase();
      const token = uuid(tx.appAccountToken);
      // 这笔交易就是这个账号买的(账号标识是购买时 App 传给苹果的),或者订阅已经绑定在这个账号
      const bought = token === me;
      const mine = bought || uuid(await bindingOwner(trx, otid)) === me;
      const previous = mine && !bought ? null : await previousOwner(trx, otid, me, token);
      if (!mine) {
        // 不是这个账号买的:只有原来的主人已经注销时才换绑过来,还在用的不动
        if (!previous) throw new HttpError(403, "no_account_token", "这笔购买没有关联语途账号,请联系客服处理");
        if (!previous.deleted) throw wrongAccount();
      } else if (previous && !previous.deleted) {
        // 这个账号自己买的,但订阅现在在另一个还在用的账号名下:只有比那边更新的购买(重新订阅、升级)才转过来,
        // 拿自己以前的旧交易不能把订阅抢回来
        if (isStale((await loadSubscription(trx, previous.userId)).sub, tx.periodEnd, deps.now())) throw wrongAccount();
      }
      return applyItem(trx, deps, userId, item, previous);
    });
    return res(sub, deps.now());
  });

  /** App Store 服务器通知 V2:苹果的服务器调用,不登录,靠签名确认来源。回 2xx 苹果就不再重发 */
  app.post(ROUTES.appleNotification, async (req) => {
    const store = deps.appStore;
    // 503:苹果会按自己的节奏重发,开通后还能收到
    if (!store) throw disabled();
    const { signedPayload } = NotificationBody.parse(req.body);
    const n = await verified(req.log, () => store.verifyNotification(signedPayload));
    await deps.db.transaction().execute(async (trx) => {
      const otid = n.originalTransactionId;
      if (otid) await lockOriginalTransaction(trx, otid);
      const { userId, previous } = otid ? await notificationOwner(trx, otid, uuid(n.appAccountToken), n.periodEnd, deps.now()) : NOBODY;
      const fresh = await recordAppleNotification(trx, {
        id: n.notificationUUID, type: n.notificationType, subtype: n.subtype, originalTransactionId: otid,
        userId, environment: n.environment, signedAt: n.signedAt, raw: n.raw,
      });
      // 同一条通知重复发来:已经处理过
      if (!fresh) return;
      await applyItem(trx, deps, userId, {
        source: "apple-notification", environment: n.environment, originalTransactionId: otid,
        productId: n.productId, periodEnd: n.periodEnd, events: n.events, raw: n.raw,
      }, previous);
    });
    return { ok: true };
  });
}

const wrongAccount = () => new HttpError(403, "wrong_account", "这笔购买属于另一个语途账号,请登录购买时用的账号");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 账号标识统一成小写 UUID(我们的用户 id 是小写的,苹果给回来的大小写不一定) */
const uuid = (id: string | null | undefined) => (id && UUID.test(id) ? id.toLowerCase() : undefined);

/** 订阅原来的主人:userId(按我们存的写法,注销了的按小写 UUID)和这个账号是否已经注销(注销或者这一行已经没了都算) */
interface Owner {
  userId: string;
  deleted: boolean;
}

/**
 * 这个订阅原来属于谁(不算 self):先看绑定记录;没有绑定(账号注销时会删掉)再看交易里的账号标识、
 * 流水里最近出现的账号标识。都没有(比如在 App 外买的、从来没对应过账号)返回 null。
 */
async function previousOwner(trx: Db, otid: string, self: string, token?: string): Promise<Owner | null> {
  const owner = async (userId: string): Promise<Owner> => {
    const active = await activeUserId(trx, userId);
    return active ? { userId: active, deleted: false } : { userId, deleted: true };
  };
  const bound = await bindingOwner(trx, otid);
  if (bound) return uuid(bound) === self ? null : owner(bound);
  for (const t of [token, ...(await recentAccountTokens(trx, otid))]) {
    const id = uuid(t);
    if (id && id !== self) return owner(id);
  }
  return null;
}

const NOBODY = { userId: null, previous: null };

/**
 * 苹果通知记到谁名下。优先交易里的账号标识(还在用的账号):同一个 Apple ID 在新账号里重新买了,通知带的就是新账号;
 * 其次是订阅现在绑定的账号(还在用的):换绑以后苹果的通知里仍然是原来那个已注销账号的标识。
 * 都不是还在用的账号就先不记到任何人名下(user_id 为空),等有人恢复购买时补上。已注销的账号不会再收到会员。
 */
async function notificationOwner(trx: Db, otid: string, token: string | undefined, periodEnd: Date | undefined, now: Date): Promise<{ userId: string | null; previous: Owner | null }> {
  const boundRow = await bindingOwner(trx, otid);
  const bound = boundRow ? await activeUserId(trx, boundRow) : null;
  const tokenUser = token ? await activeUserId(trx, token) : null;
  if (tokenUser && tokenUser !== bound) {
    // 订阅现在在另一个还在用的账号名下,而这条是更早一期的数据:还是那个账号的,只记流水
    if (bound && isStale((await loadSubscription(trx, bound)).sub, periodEnd, now)) return { userId: bound, previous: null };
    return { userId: tokenUser, previous: await previousOwner(trx, otid, tokenUser.toLowerCase()) };
  }
  return bound ? { userId: bound, previous: null } : NOBODY;
}

interface StoreItem {
  source: string;
  environment?: string;
  originalTransactionId?: string;
  productId?: string;
  periodEnd?: Date;
  events: StoreEvent[];
  raw?: unknown;
}

/**
 * 一条校验过的商店数据(交易或通知):记流水,再把第一次见到的事件应用到这个用户的会员状态。
 * userId 为空(还不知道是谁的)时只记流水,等用户上报同一订阅的交易时补上。
 * previous 不为空表示换绑:订阅原来属于另一个账号(已注销,或者这个账号重新买了它)。
 * 调用前要先锁上这个订阅(lockOriginalTransaction),这里再锁用户,顺序固定。
 */
async function applyItem(trx: Db, deps: Deps, userId: string | null, item: StoreItem, previous: Owner | null = null): Promise<Subscription | null> {
  const now = deps.now();
  if (userId) await lockUserSubscription(trx, userId);
  const fresh = await recordEvents(trx, item.events.map((event) => ({
    event, userId, source: item.source, environment: item.environment, originalTransactionId: item.originalTransactionId,
    productId: item.productId, periodEnd: item.periodEnd, raw: item.raw,
  })));
  if (!userId) return null;

  const { sub: before, originalTransactionId } = await loadSubscription(trx, userId);
  let sub = before;
  // 之前没对应上用户的同一订阅的事件,按发生顺序先补上(包括原来的主人注销时去掉了账号关联的流水,换绑时用它重建会员状态)
  if (item.originalTransactionId) {
    const fromDeleted = previous?.deleted ? previous.userId : undefined;
    for (const o of await claimOrphanEvents(trx, userId, item.originalTransactionId, fromDeleted)) sub = applyStoreEvents(sub, [o.event], o.periodEnd, now);
  }
  sub = applyStoreEvents(sub, item.events.filter((e) => fresh.has(e.id)), item.periodEnd, now);
  const otid = item.originalTransactionId;
  const rebind = !!(sub && otid && previous);
  if (rebind) {
    // 原来主人名下的这个订阅删掉(已注销的账号这一行通常已经没了);审计只记 id,已注销的不再和新账号关联
    await deleteBoundSubscription(trx, previous!.userId, otid!);
    await recordRebind(trx, { originalTransactionId: otid!, oldUserId: previous!.deleted ? "deleted" : previous!.userId, newUserId: userId, source: item.source, at: now });
  }
  if (sub && (sub !== before || rebind)) await saveSubscription(trx, userId, sub, otid ?? originalTransactionId, now);
  return sub;
}

/** 校验失败:签名不对回 400;暂时性失败(连不上苹果检查证书)回 503,苹果会重发、App 会重试 */
async function verified<T>(log: FastifyBaseLogger, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof StoreVerificationError)) throw e;
    log.warn({ reason: e.reason, err: e.cause ?? e }, "苹果数据校验失败");
    throw e.retryable
      ? new HttpError(503, "verify_unavailable", "暂时无法确认购买,请稍后再试")
      : new HttpError(400, "invalid_receipt", "购买凭证校验失败");
  }
}
