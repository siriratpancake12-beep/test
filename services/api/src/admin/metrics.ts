import { sql } from "kysely";
import { isPremium, type MetricsRes, type Subscription } from "@lingo/core";
import type { Db } from "../db";

/**
 * 后台指标(定义见 docs/04-续订与学习效果方案.md 第七节)。日期一律按 UTC。
 *
 * 区间 [from 0 点, to 次日 0 点)。"能观察到的截止时间" seen = min(区间结束, 现在):
 * 查询包含今天时,第 N 天还没过完的人、试用还没满 7 天的人不进样本,否则比例会偏低。
 * 订阅表(subscriptions、subscription_events)由支付模块维护,这里只读。
 */
const DAY = 86_400_000;
/** 算作"学习"的事件 */
export const LEARNING_EVENTS = ["lesson_complete", "review_complete", "drill_complete"] as const;

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

export async function computeMetrics(db: Db, from: string, to: string, now: Date): Promise<MetricsRes> {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + DAY);
  const seen = end.getTime() < now.getTime() ? end : now;
  // "区间最后 7 天":以 to 为最后一天的 7 个自然日
  const weekStart = new Date(end.getTime() - 7 * DAY);
  const learn = sql.join([...LEARNING_EVENTS]);

  const newUsers = async () => {
    const r = await sql<{ n: number }>`select count(*)::int as n from users where created_at >= ${start} and created_at < ${end}`.execute(db);
    return Number(r.rows[0]?.n ?? 0);
  };

  /**
   * 第 N 天留存:区间内注册的人里,注册后第 N 天(注册当天是第 0 天,按 UTC 日期)有学习的比例。
   * 只算第 N 天已经整天过去的人。已注销的不算:注销时他的学习记录和账号断开了,
   * 算进去会把学过的人也当成"没留下"。
   */
  const retention = async (n: number) => {
    const r = await sql<{ total: number; kept: number }>`
      with cohort as (
        select id, (created_at at time zone 'UTC')::date + ${n}::int as day
        from users
        where created_at >= ${start} and created_at < ${end} and deleted_at is null
      )
      select count(*)::int as total,
        (count(*) filter (where exists (
          select 1 from events e
          where e.user_id = cohort.id and e.name in (${learn})
            and e.at >= (cohort.day::timestamp at time zone 'UTC')
            and e.at < ((cohort.day + 1)::timestamp at time zone 'UTC')
        )))::int as kept
      from cohort
      where ((cohort.day + 1)::timestamp at time zone 'UTC') <= ${seen}
    `.execute(db);
    const row = r.rows[0];
    return ratio(Number(row?.kept ?? 0), Number(row?.total ?? 0));
  };

  /**
   * 周活跃学习者:最后 7 天有学习事件的不同的人。登录的按账号算,没登录的按 anonId 算;
   * 同一台设备登录前的匿名事件(anonId 后来出现在登录事件里)算到那个账号上,不重复计数。
   */
  const weeklyActive = async () => {
    const r = await sql<{ n: number }>`
      with learn as (
        select user_id, anon_id from events
        where name in (${learn}) and at >= ${weekStart} and at < ${end}
      ),
      linked as (
        select anon_id, min(user_id) as user_id from events
        where user_id is not null and anon_id in (select anon_id from learn where user_id is null)
        group by anon_id
      )
      select count(distinct coalesce(l.user_id, k.user_id, 'anon:' || l.anon_id))::int as n
      from learn l left join linked k on l.user_id is null and k.anon_id = l.anon_id
    `.execute(db);
    return Number(r.rows[0]?.n ?? 0);
  };

  /**
   * 北极星:最后 7 天学习 ≥ 3 个不同日子、且在截止时是会员的人。
   * 会员按订阅表的当前状态判断(core 的 isPremium:trial/active/grace 且没过期);
   * 订阅表只有当前状态,查很早以前的区间时是近似值。
   */
  const northStar = async () => {
    const r = await sql<{ user_id: string; data: unknown }>`
      select a.user_id, s.data from (
        select user_id from events
        where user_id is not null and name in (${learn}) and at >= ${weekStart} and at < ${end}
        group by user_id
        having count(distinct (at at time zone 'UTC')::date) >= 3
      ) a join subscriptions s on s.user_id = a.user_id
    `.execute(db);
    return r.rows.filter((row) => {
      const sub = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as Subscription | null;
      return isPremium(sub, seen);
    }).length;
  };

  const subCounts = async () => {
    const types = ["start-trial", "purchase", "renewed", "expired", "refunded"];
    const r = await sql<{ type: string; n: number }>`
      select type, count(*)::int as n from subscription_events
      where at >= ${start} and at < ${end} and type in (${sql.join(types)})
      group by type
    `.execute(db);
    const c = new Map(r.rows.map((row) => [row.type, Number(row.n)]));
    return (t: string) => c.get(t) ?? 0;
  };

  /**
   * 试用转付费:区间内开始试用、且到截止时已经满 7 天的人里,之后有 purchase 或 renewed 的比例。
   * 同一个人记了多条 start-trial 只算一次(按最早那条);同一时刻的 purchase 不算(那是试用本身那笔交易)。
   */
  const trialToPaid = async () => {
    const r = await sql<{ total: number; paid: number }>`
      with trials as (
        select user_id, min(at) as at from subscription_events
        where type = 'start-trial' and user_id is not null and at >= ${start} and at < ${end}
        group by user_id
      )
      select count(*)::int as total,
        (count(*) filter (where exists (
          select 1 from subscription_events p
          where p.user_id = trials.user_id and p.type in ('purchase', 'renewed') and p.at > trials.at
        )))::int as paid
      from trials
      where trials.at <= ${new Date(seen.getTime() - 7 * DAY)}
    `.execute(db);
    const row = r.rows[0];
    return ratio(Number(row?.paid ?? 0), Number(row?.total ?? 0));
  };

  const [users, d1, d7, d30, wal, ns, count, t2p] = await Promise.all([
    newUsers(), retention(1), retention(7), retention(30), weeklyActive(), northStar(), subCounts(), trialToPaid(),
  ]);
  return {
    from,
    to,
    retention: { d1, d7, d30 },
    newUsers: users,
    weeklyActiveLearners: wal,
    northStar: ns,
    trialStarts: count("start-trial"),
    trialToPaid: t2p,
    renewalRate: ratio(count("renewed"), count("renewed") + count("expired")),
    refundRate: ratio(count("refunded"), count("purchase") + count("renewed")),
  };
}
