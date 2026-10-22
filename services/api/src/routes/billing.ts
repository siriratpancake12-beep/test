import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import {
  applyStoreEvents, createAppleVerifier, loadAppleRootCertificates, StoreVerificationError, type AppStoreVerifier, type StoreEvent,
} from "@lingo/billing";
import { AppleTransactionReq, isPremium, ROUTES, type Subscription, type SubscriptionRes } from "@lingo/core";
import type { Deps } from "../app";
import { requireUser } from "../auth/session";
import type { Config } from "../config";
import type { Db } from "../db";
import {
  claimOrphanEvents, findAppleUser, loadSubscription, lockUserSubscription, recordAppleNotification, recordEvents, saveSubscription,
} from "../db/billing";
import { HttpError } from "../errors";

/**
 * 订阅:查询会员状态、App 上报交易、App Store 服务器通知。负责人:billing。
 *
 * 以服务器记录为准:App 买完把交易交给这里校验;之后的续费、扣费失败、过期、退款都由苹果的服务器通知告诉我们。
 * 两条路可能同时到、乱序到、重复到,所以:事件按固定 id 只记一次、只应用一次;过时的数据不改状态;同一用户排队更新。
 * 接入说明见 docs/08-支付接入.md。
 */

/**
 * 按配置创建 App Store 校验器;缺配置就返回 null(交易接口回 503"支付服务暂未开通")。
 * 苹果根证书放在 APPLE_ROOT_CERTS_DIR 指定的目录(不进仓库)。
 */
export function createAppStoreVerifier(config: Config, env: NodeJS.ProcessEnv = process.env): AppStoreVerifier | null {
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
  // 目录以后由 config.apple.rootCertsDir 提供(config.ts 归 server-core),现在先直接读环境变量
  const dir = (a as { rootCertsDir?: string }).rootCertsDir ?? env.APPLE_ROOT_CERTS_DIR;
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
    // 账号标识是购买时 App 传给苹果的当前用户 id:只给买的那个账号开通,别人拿到这串交易也用不了
    if (!tx.appAccountToken) throw new HttpError(403, "no_account_token", "这笔购买没有关联语途账号,请联系客服处理");
    if (tx.appAccountToken.toLowerCase() !== userId.toLowerCase()) {
      throw new HttpError(403, "wrong_account", "这笔购买属于另一个语途账号,请登录购买时用的账号");
    }
    const sub = await deps.db.transaction().execute((trx) => applyItem(trx, deps, userId, {
      source: "apple-transaction", environment: tx.environment, originalTransactionId: tx.originalTransactionId,
      productId: tx.productId, periodEnd: tx.periodEnd, events: tx.events, raw: tx.raw,
    }));
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
      const userId = await findAppleUser(trx, n);
      const fresh = await recordAppleNotification(trx, {
        id: n.notificationUUID, type: n.notificationType, subtype: n.subtype, originalTransactionId: n.originalTransactionId,
        userId, environment: n.environment, signedAt: n.signedAt, raw: n.raw,
      });
      // 同一条通知重复发来:已经处理过
      if (!fresh) return;
      await applyItem(trx, deps, userId, {
        source: "apple-notification", environment: n.environment, originalTransactionId: n.originalTransactionId,
        productId: n.productId, periodEnd: n.periodEnd, events: n.events, raw: n.raw,
      });
    });
    return { ok: true };
  });
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
 */
async function applyItem(trx: Db, deps: Deps, userId: string | null, item: StoreItem): Promise<Subscription | null> {
  const now = deps.now();
  if (userId) await lockUserSubscription(trx, userId);
  const fresh = await recordEvents(trx, item.events.map((event) => ({
    event, userId, source: item.source, environment: item.environment, originalTransactionId: item.originalTransactionId,
    productId: item.productId, periodEnd: item.periodEnd, raw: item.raw,
  })));
  if (!userId) return null;

  const { sub: before, originalTransactionId } = await loadSubscription(trx, userId);
  let sub = before;
  // 之前没对应上用户的同一订阅的事件,按发生顺序先补上
  if (item.originalTransactionId) {
    for (const o of await claimOrphanEvents(trx, userId, item.originalTransactionId)) sub = applyStoreEvents(sub, [o.event], o.periodEnd, now);
  }
  sub = applyStoreEvents(sub, item.events.filter((e) => fresh.has(e.id)), item.periodEnd, now);
  if (sub && sub !== before) await saveSubscription(trx, userId, sub, item.originalTransactionId ?? originalTransactionId, now);
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
