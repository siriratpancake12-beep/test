import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { productById, type Product, type Subscription } from "@lingo/core";
import type { Db } from "../db";
import { AliyunSmsError } from "../auth/aliyun-sms";
import type { SmsNotifier } from "../routes/auth";
import type { JobLog } from "./index";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * 扣费前短信提醒。《网络交易监督管理办法》第十八条:自动续费的,要在续费日期前五日以显著方式提请消费者注意。
 * App 在扣费前 5 天、1 天发本机通知,首页也会显示;但通知可能被关掉、被系统清理(国内安卓尤其常见),
 * 所以绑定了手机号的会员再发一条短信。
 *
 * - 发给谁:开着自动续费、正在试用或在有效期内的会员,账号绑定了手机号、没有注销。关掉了续费、已经过期、
 *   扣费失败(宽限期、重试中)的都不发。只提醒苹果正式环境的订阅:沙盒是审核、TestFlight 和我们自己测试用的,
 *   不扣真钱(沙盒的"一年"只有一小时)。
 * - 每个账号每一期(按这一期的到期时间区分)最多一条:几台服务器同时跑、任务重跑、关掉又打开自动续费,都不会重复发。
 * - 什么时候发:离到期还有 5 天到 5 天半之间,只在北京时间 8 点到 21 点发(夜里不发)。多出的半天正好盖住一个晚上,
 *   所以收到短信时离到期至少还有 5 天。第一次看到时已经不到 5 天的(比如快到期时又打开了自动续费、服务器停过),
 *   离到期还有 1 天以上也照发;不到 1 天就不发了:苹果在到期前 24 小时内扣费,这时可能已经扣了,最后一天 App 自己会提醒。
 * - 发送失败:短信服务商明确报错、连不上的,下一个小时再试,最多 3 次;超时的可能已经发出去了,不再重发(宁可少一条也不重复)。
 * - 商品和价格按下一期真正要扣的(降级、换档到下一期才生效),和 App 的提醒一致。价格来自 core 的 PRODUCTS(人民币),
 *   非中国区 Apple ID 的实际价格可能不同(App 的提醒也是这样,见 docs/08)。
 *
 * 短信模板在阿里云申请(通知短信),三个变量:${product}(年度会员 / 月度会员)、${date}(到期日,如 2026年11月6日)、
 * ${price}(数字,如 298)。模板 CODE 配在 SMS_RENEWAL_TEMPLATE_CODE;没配就不发,并在日志里说明。
 */
export const RENEWAL_SMS = {
  /** 提前多久提醒 */
  leadMs: 5 * DAY,
  /** 最多再提前这么久:夜里不发,赶在"还剩 5 天"之前的白天发出去 */
  earlyMs: 12 * HOUR,
  /** 离到期不到这么久就不发了 */
  minLeftMs: DAY,
  /** 北京时间 [fromHour, toHour) 之间才发 */
  fromHour: 8,
  toHour: 21,
  /** 明确失败的最多试几次 */
  maxAttempts: 3,
  /** 一轮最多发多少条,剩下的下一个小时接着发(最急的先发) */
  perRun: 1000,
} as const;

export interface RenewalSmsPlan {
  /** 这一期的到期时间(也是这条提醒的去重依据) */
  periodEnd: Date;
  /** 下一期要扣费的商品 */
  product: Product;
  /** 短信模板变量 */
  params: { product: string; date: string; price: string };
}

/** 这个订阅现在该不该发扣费前短信(不看是否发过、是否白天),该发就给出短信内容 */
export function renewalSmsPlan(sub: Subscription | null, now: Date): RenewalSmsPlan | null {
  if (!sub || !sub.autoRenew || (sub.status !== "trial" && sub.status !== "active")) return null;
  const end = Date.parse(sub.periodEnd);
  if (!Number.isFinite(end)) return null;
  const left = end - now.getTime();
  if (left <= RENEWAL_SMS.minLeftMs || left > RENEWAL_SMS.leadMs + RENEWAL_SMS.earlyMs) return null;
  const product = (sub.renewProductId && productById(sub.renewProductId)) || productById(sub.productId);
  if (!product) return null;
  return { periodEnd: new Date(end), product, params: { product: product.titleZh, date: beijingDate(end), price: String(product.priceCny) } };
}

/** 北京时间的日期,如 2026年11月6日 */
function beijingDate(t: number): string {
  const d = new Date(t + 8 * HOUR);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** 北京时间现在可不可以发短信 */
export function smsHours(now: Date): boolean {
  const h = new Date(now.getTime() + 8 * HOUR).getUTCHours();
  return h >= RENEWAL_SMS.fromHour && h < RENEWAL_SMS.toHour;
}

export interface RenewalSmsReport {
  /** 没发的原因:没配模板 / 夜里 */
  skipped?: "no_template" | "quiet_hours";
  /** 这一轮该发的 */
  due: number;
  sent: number;
  /** 明确失败(下一轮再试) */
  failed: number;
  /** 超时,不知道发没发出去(不再重发) */
  unknown: number;
}

interface Due {
  user_id: string;
  phone: string;
  original_transaction_id: string | null;
  data: unknown;
}

export async function sendRenewalReminders(opts: {
  db: Db; now: Date; notifier: SmsNotifier; templateCode: string | undefined; log: JobLog; limit?: number;
}): Promise<RenewalSmsReport> {
  const { db, now, notifier, templateCode, log } = opts;
  const report: RenewalSmsReport = { due: 0, sent: 0, failed: 0, unknown: 0 };
  if (!templateCode) {
    log.warn({}, "没有配置扣费提醒短信模板(SMS_RENEWAL_TEMPLATE_CODE),不发扣费前短信");
    return { ...report, skipped: "no_template" };
  }
  if (!smsHours(now)) return { ...report, skipped: "quiet_hours" };

  const minEnd = new Date(now.getTime() + RENEWAL_SMS.minLeftMs);
  const maxEnd = new Date(now.getTime() + RENEWAL_SMS.leadMs + RENEWAL_SMS.earlyMs);
  // 先在数据库里粗筛(状态、自动续费、到期时间、正式环境、这一期还没发过或者失败了还能再试),再用 renewalSmsPlan 逐个确认
  const rows = await sql<Due>`
    select s.user_id, u.phone, s.original_transaction_id, s.data
    from subscriptions s join users u on u.id = s.user_id
    where u.deleted_at is null and u.phone is not null
      and s.data->>'autoRenew' = 'true' and s.data->>'status' in ('trial', 'active')
      and (s.data->>'periodEnd')::timestamptz > ${minEnd} and (s.data->>'periodEnd')::timestamptz <= ${maxEnd}
      and exists (
        select 1 from subscription_events e
        where e.original_transaction_id = s.original_transaction_id and e.environment = 'Production'
      )
      and not exists (
        select 1 from renewal_sms r
        where r.user_id = s.user_id and r.period_end = (s.data->>'periodEnd')::timestamptz
          and (r.status <> 'failed' or r.attempts >= ${RENEWAL_SMS.maxAttempts})
      )
    order by (s.data->>'periodEnd')::timestamptz
    limit ${opts.limit ?? RENEWAL_SMS.perRun}
  `.execute(db);

  for (const row of rows.rows) {
    const sub = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as Subscription;
    const plan = renewalSmsPlan(sub, now);
    if (!plan) continue;
    report.due++;
    // 先占位再发:同一个账号同一期只有一行(唯一索引),几台服务器同时跑也只有一台占得到;明确失败过的可以重新占
    const claimed = await db.insertInto("renewal_sms")
      .values({
        id: randomUUID(), user_id: row.user_id, original_transaction_id: row.original_transaction_id, period_end: plan.periodEnd,
        product_id: plan.product.id, price_cny: plan.product.priceCny, status: "sending", attempts: 1, error: null,
        created_at: now, updated_at: now, sent_at: null,
      })
      .onConflict((oc) => oc.columns(["user_id", "period_end"])
        .doUpdateSet({ status: "sending", attempts: sql<number>`renewal_sms.attempts + 1`, updated_at: now })
        .where("renewal_sms.status", "=", "failed")
        .where("renewal_sms.attempts", "<", RENEWAL_SMS.maxAttempts))
      .returning("id")
      .executeTakeFirst();
    if (!claimed) continue;
    try {
      await notifier.notify(row.phone, templateCode, plan.params);
      await db.updateTable("renewal_sms").set({ status: "sent", sent_at: now, updated_at: now, error: null }).where("id", "=", claimed.id).execute();
      report.sent++;
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const error = err instanceof AliyunSmsError ? err.code : err instanceof Error ? err.name : "error";
      await db.updateTable("renewal_sms").set({ status: timeout ? "unknown" : "failed", error, updated_at: now }).where("id", "=", claimed.id).execute();
      if (timeout) report.unknown++;
      else report.failed++;
      // 日志里不记手机号
      log.warn({ err, userId: row.user_id }, timeout ? "扣费提醒短信超时(可能已经发出,不再重发)" : "扣费提醒短信发送失败(下一轮再试)");
    }
  }
  return report;
}
