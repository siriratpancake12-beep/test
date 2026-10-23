import { sql } from "kysely";
import type { Db } from "../db";
import { forgetBillingUser } from "../db/billing";
import { utcDay } from "../db/ai";
import { SMS_RULES } from "../auth/sms-code";

/**
 * 按《隐私政策》第三节"保存期限"清理服务器上的数据。每天跑一次(jobs/index.ts),也可以 npm run purge 手动跑。
 * 这里的数字和协议原文一一对应:改协议要一起改这里,反过来也一样。
 *
 * | 协议写的                                   | 这里怎么做 |
 * | 使用统计数据:自收集之日起不超过 24 个月      | events 按服务器收到的时间(received_at)删;提前 1 天删,每天跑一次也不会超过 24 个月 |
 * | AI 对话:只记使用次数,按使用统计的期限       | ai_usage 按日期删,同上 |
 * | 订阅交易记录:自交易完成之日起 3 年           | 按订阅(原始交易 id)算:最后一笔交易、最后一期都结束满 3 年,才删这个订阅的流水、苹果通知、换绑记录 |
 * |                                            | (还在续的订阅,早年的流水要用来恢复购买、换绑时重建会员状态,不能一笔一笔删;扣费提醒记录按那一期删) |
 * | 短信验证码:5 分钟内有效,使用后作废          | 有效期在 SMS_RULES;发送记录(手机号、IP,限流用)两天后删——发验证码时会顺手删,这里兜底(没人发验证码时也删) |
 * | 注销后 15 个工作日内删除或匿名化              | 注销时当场删(routes/account.ts);这里每天再扫一遍注销账号的残留:注销那一刻正在进行的请求(同步进度、上传埋点、苹果通知)可能又写进来 |
 * | 网络日志 6 个月                             | 服务器不在数据库里存网络日志(写到标准输出),在日志服务里设保存天数,见 docs/07 第七节 |
 *
 * 每一步都可以重复执行;某一步出错不会回滚前面已经删掉的(各步互不依赖),下一次接着删。
 */
export const RETENTION = {
  /** 使用统计、AI 用量:不超过 24 个月 */
  usageMonths: 24,
  /** "不超过"的期限提前这么多删:任务每天跑一次,最晚也在到期前删掉 */
  usageMarginMs: 86_400_000,
  /** 订阅交易记录:3 年(《电子商务法》不少于三年,所以不提前) */
  transactionYears: 3,
  /** 验证码发送记录 */
  smsCodesMs: SMS_RULES.keepMs,
  /** 定时任务的运行记录(只有条数,没有个人信息):留一年,备查"保存期限执行了" */
  jobRunsMs: 365 * 86_400_000,
  /** 埋点一次删多少行:表很大时分批删,不长时间锁表 */
  batch: 5000,
} as const;

export interface PurgeReport {
  /** 使用统计(埋点) */
  events: number;
  aiUsage: number;
  smsCodes: number;
  /** 交易记录:到期的订阅个数,和删掉的流水、通知、换绑记录的行数 */
  transactions: { subscriptions: number; events: number; notifications: number; rebinds: number };
  renewalSms: number;
  jobRuns: number;
  /** 注销账号的残留(注销时正在进行的请求写进来的):清掉的行数 */
  deletedAccounts: { identities: number; progress: number; aiUsage: number; events: number; billing: number; renewalSms: number };
}

/** 往前推 n 个日历月(UTC) */
export function monthsBefore(now: Date, n: number): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

/** 往前推 n 年(UTC)。2 月 29 日往前推到平年是 3 月 1 日:比 2 月 28 日晚,只会多留一天,不会提前删 */
export function yearsBefore(now: Date, n: number): Date {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
}

const count = (r: { numDeletedRows?: bigint; numUpdatedRows?: bigint } | undefined) => Number(r?.numDeletedRows ?? r?.numUpdatedRows ?? 0n);

/** batch:埋点一次删多少行(测试用来验证分批删) */
export async function purgeExpired(db: Db, now: Date, opts: { batch?: number } = {}): Promise<PurgeReport> {
  const deletedAccounts = await sweepDeletedAccounts(db);

  // 使用统计:按服务器收到的时间(收集之日);App 离线时攒下的晚上传,从收到那天算起
  const usageCutoff = new Date(monthsBefore(now, RETENTION.usageMonths).getTime() + RETENTION.usageMarginMs);
  const events = await deleteEventsReceivedBefore(db, usageCutoff, opts.batch ?? RETENTION.batch);
  const aiUsage = count(await db.deleteFrom("ai_usage").where("day", "<", utcDay(usageCutoff)).executeTakeFirst());

  const smsCodes = count(await db.deleteFrom("sms_codes").where("created_at", "<", new Date(now.getTime() - RETENTION.smsCodesMs)).executeTakeFirst());

  const txCutoff = yearsBefore(now, RETENTION.transactionYears);
  const transactions = await purgeTransactions(db, txCutoff);
  // 扣费提醒记录是"这一期提醒过"的凭据,跟着那一期的交易走
  const renewalSms = count(await db.deleteFrom("renewal_sms").where("period_end", "<", txCutoff).executeTakeFirst());

  const jobRuns = count(await db.deleteFrom("job_runs").where("started_at", "<", new Date(now.getTime() - RETENTION.jobRunsMs)).executeTakeFirst());

  return { events, aiUsage, smsCodes, transactions, renewalSms, jobRuns, deletedAccounts };
}

async function deleteEventsReceivedBefore(db: Db, cutoff: Date, size: number): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = db.selectFrom("events").select("id").where("received_at", "<", cutoff).limit(size);
    const n = count(await db.deleteFrom("events").where("id", "in", batch).executeTakeFirst());
    total += n;
    if (n < size) return total;
  }
}

/**
 * 交易记录按订阅删:这个订阅所有的流水(交易时间、那一期的到期时间)、苹果通知、换绑记录里最晚的时间,早于 cutoff 才删。
 * 不带原始交易 id 的(比如苹果的测试通知)按各自的时间删。
 * 订阅状态(subscriptions)不删:它是账号的会员状态,跟着账号走(注销时删)。
 */
async function purgeTransactions(db: Db, cutoff: Date): Promise<PurgeReport["transactions"]> {
  const stale = await sql<{ otid: string }>`
    select otid from (
      select original_transaction_id as otid, greatest(at, coalesce(period_end, at)) as t
        from subscription_events where original_transaction_id is not null
      union all
      select original_transaction_id, signed_at from apple_notifications where original_transaction_id is not null
      union all
      select original_transaction_id, at from subscription_rebinds
    ) x
    group by otid
    having max(t) < ${cutoff}
  `.execute(db);
  const out = { subscriptions: stale.rows.length, events: 0, notifications: 0, rebinds: 0 };
  const ids = stale.rows.map((r) => r.otid);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.events += count(await db.deleteFrom("subscription_events").where("original_transaction_id", "in", chunk).executeTakeFirst());
    out.notifications += count(await db.deleteFrom("apple_notifications").where("original_transaction_id", "in", chunk).executeTakeFirst());
    out.rebinds += count(await db.deleteFrom("subscription_rebinds").where("original_transaction_id", "in", chunk).executeTakeFirst());
  }
  out.events += count(await db.deleteFrom("subscription_events").where("original_transaction_id", "is", null).where("at", "<", cutoff).executeTakeFirst());
  out.notifications += count(await db.deleteFrom("apple_notifications").where("original_transaction_id", "is", null).where("signed_at", "<", cutoff).executeTakeFirst());
  return out;
}

/**
 * 注销账号的残留。注销本身在 routes/account.ts 里当场完成;但注销那一刻已经通过登录检查、还没写完的请求
 * (同步进度、上传埋点、AI 用量、苹果通知更新会员)可能在注销之后又写进来。这里按注销时的规则再清一遍:
 * 进度、AI 用量删掉;埋点、扣费提醒记录和这个人断开;支付相关的按 forgetBillingUser 处理;账号行上的标识清空。
 */
async function sweepDeletedAccounts(db: Db): Promise<PurgeReport["deletedAccounts"]> {
  const deleted = () => db.selectFrom("users").select("id").where("deleted_at", "is not", null);
  const identities = count(await db.updateTable("users")
    .set({ phone: null, apple_sub: null, apple_refresh_token: null, wechat_unionid: null, wechat_openid: null })
    .where("deleted_at", "is not", null)
    .where((eb) => eb.or([
      eb("phone", "is not", null), eb("apple_sub", "is not", null), eb("apple_refresh_token", "is not", null),
      eb("wechat_unionid", "is not", null), eb("wechat_openid", "is not", null),
    ]))
    .executeTakeFirst());
  const progress = count(await db.deleteFrom("progress").where("user_id", "in", deleted()).executeTakeFirst());
  const aiUsage = count(await db.deleteFrom("ai_usage").where("user_id", "in", deleted()).executeTakeFirst());
  const events = count(await db.updateTable("events").set({ user_id: null }).where("user_id", "in", deleted()).executeTakeFirst());
  const renewalSms = count(await db.updateTable("renewal_sms").set({ user_id: null }).where("user_id", "in", deleted()).executeTakeFirst());

  const billingUsers = await sql<{ user_id: string }>`
    select user_id from subscriptions where user_id in (select id from users where deleted_at is not null)
    union select user_id from subscription_events where user_id in (select id from users where deleted_at is not null)
    union select user_id from apple_notifications where user_id in (select id from users where deleted_at is not null)
    union select old_user_id from subscription_rebinds where old_user_id in (select id from users where deleted_at is not null)
    union select new_user_id from subscription_rebinds where new_user_id in (select id from users where deleted_at is not null)
  `.execute(db);
  for (const { user_id } of billingUsers.rows) await db.transaction().execute((trx) => forgetBillingUser(trx, user_id));

  return { identities, progress, aiUsage, events, billing: billingUsers.rows.length, renewalSms };
}
