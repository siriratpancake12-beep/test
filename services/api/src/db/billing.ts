import { randomUUID } from "node:crypto";
import { sql, type Generated, type Kysely } from "kysely";
import type { SubEvent, Subscription } from "@lingo/core";
import type { Db } from "./index";

/**
 * 订阅、交易记录的表。负责人:支付模块(billing)。
 * 后台指标(试用转付费、续费率、退款率)读 subscription_events,列名不要改(可以加列)。
 *
 * 写入规则(routes/billing.ts):
 * - subscription_events 的 id 是事件的固定 id(见 @lingo/billing 的 StoreEvent):同一件事从 App 上报、苹果通知、
 *   苹果重发来多少次都只有一行,指标不会重复计数。
 * - 还没对应到用户的事件 user_id 为空,用户上报同一订阅的交易时补上并应用。
 * - environment 为 Sandbox 的是苹果审核、TestFlight、我们自己测试的数据,算指标时要排除。
 * - 原来的账号注销后,同一个 Apple ID 在新账号里恢复购买时,订阅换绑到新账号(规则见 routes/billing.ts),
 *   每次换绑在 subscription_rebinds 记一行。
 */
export interface BillingTables {
  subscriptions: {
    user_id: string;
    /** core 的 Subscription(JSON) */
    data: unknown;
    original_transaction_id: string | null;
    updated_at: Date;
  };
  subscription_events: {
    id: string;
    user_id: string | null;
    /** core SubEvent 的 type:start-trial / purchase / renewed / billing-failed / auto-renew / expired / refunded */
    type: string;
    product_id: string | null;
    at: Date;
    /** apple-transaction / apple-notification / … */
    source: string;
    /**
     * 商店给的原始数据(解码后),对账用:@lingo/billing 给的 { notification?, transaction?, renewal? }。
     * 通知类型在 raw.notification.notificationType;换绑时从 transaction / renewal 的 appAccountToken 看订阅原来是谁的
     */
    raw: unknown;
    /** 商店的原始交易 id(同一个订阅的所有续费都一样) */
    original_transaction_id: Generated<string | null>;
    /** 事件所属那一期的到期时间,判断数据是否过时 */
    period_end: Generated<Date | null>;
    /** core 的 SubEvent(JSON),补应用时用 */
    event: Generated<unknown>;
    /** Production / Sandbox */
    environment: Generated<string | null>;
    /** 写入顺序 */
    seq: Generated<string>;
  };
  /** 收到的 App Store 服务器通知,按通知 id 去重;找不到用户的也记下(user_id 为空) */
  apple_notifications: {
    id: string;
    type: string;
    subtype: string | null;
    original_transaction_id: string | null;
    user_id: string | null;
    environment: string | null;
    signed_at: Date;
    received_at: Generated<Date>;
    raw: unknown;
  };
  /**
   * 订阅换绑记录(审计用),只有 id,没有个人信息。账号注销了就记 "deleted"(注销时把已有记录里的 id 也改掉),
   * 不再和注销的账号关联;没有账号标识的购买第一次被认领时 old_user_id 记 "none"。
   */
  subscription_rebinds: {
    id: string;
    original_transaction_id: string;
    old_user_id: string;
    new_user_id: string;
    /** apple-transaction / apple-notification / claim_no_token(没有账号标识的购买被认领) */
    source: string;
    at: Date;
  };
}

export async function migrateBilling(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("subscriptions")
    .ifNotExists()
    .addColumn("user_id", "text", (c) => c.primaryKey())
    .addColumn("data", "jsonb", (c) => c.notNull())
    .addColumn("original_transaction_id", "text", (c) => c.unique())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createTable("subscription_events")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text")
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("product_id", "text")
    .addColumn("at", "timestamptz", (c) => c.notNull())
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("raw", "jsonb")
    .execute();
  // 后加的列。已经建好表的库(开发机上的 PGlite)也要能升级,所以按需 add column
  const added: [string, string][] = [
    ["original_transaction_id", "text"], ["period_end", "timestamptz"], ["event", "jsonb"], ["environment", "text"], ["seq", "bigserial"],
  ];
  const existing = await sql<{ column_name: string }>`
    select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'subscription_events'`.execute(db);
  for (const [name, type] of added) {
    if (!existing.rows.some((r) => r.column_name === name)) {
      await sql`alter table subscription_events add column if not exists ${sql.id(name)} ${sql.raw(type)}`.execute(db);
    }
  }
  await db.schema.createIndex("subscription_events_type_at").ifNotExists().on("subscription_events").columns(["type", "at"]).execute();
  await db.schema.createIndex("subscription_events_original_tx").ifNotExists().on("subscription_events").column("original_transaction_id").execute();
  await db.schema
    .createTable("apple_notifications")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("subtype", "text")
    .addColumn("original_transaction_id", "text")
    .addColumn("user_id", "text")
    .addColumn("environment", "text")
    .addColumn("signed_at", "timestamptz", (c) => c.notNull())
    .addColumn("received_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("raw", "jsonb")
    .execute();
  await db.schema
    .createTable("subscription_rebinds")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("original_transaction_id", "text", (c) => c.notNull())
    .addColumn("old_user_id", "text", (c) => c.notNull())
    .addColumn("new_user_id", "text", (c) => c.notNull())
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("at", "timestamptz", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("subscription_rebinds_original_tx").ifNotExists().on("subscription_rebinds").column("original_transaction_id").execute();
}

// ---- 读写 ----
// jsonb 一律传 JSON 字符串:pg 驱动会把 JS 数组当成 Postgres 数组,PGlite 两种都认

export async function loadSubscription(db: Db, userId: string): Promise<{ sub: Subscription | null; originalTransactionId: string | null }> {
  const row = await db.selectFrom("subscriptions").select(["data", "original_transaction_id"]).where("user_id", "=", userId).executeTakeFirst();
  return { sub: (row?.data as Subscription | undefined) ?? null, originalTransactionId: row?.original_transaction_id ?? null };
}

export async function saveSubscription(db: Db, userId: string, sub: Subscription, originalTransactionId: string | null, now: Date): Promise<void> {
  if (originalTransactionId) {
    // 苹果允许改交易的账号标识(订阅换了主人):从原来的账号上摘下来,唯一约束才不冲突
    await db.updateTable("subscriptions").set({ original_transaction_id: null })
      .where("original_transaction_id", "=", originalTransactionId).where("user_id", "<>", userId).execute();
  }
  const data = JSON.stringify(sub);
  await db.insertInto("subscriptions")
    .values({ user_id: userId, data, original_transaction_id: originalTransactionId, updated_at: now })
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ data, original_transaction_id: originalTransactionId, updated_at: now }))
    .execute();
}

export interface EventRow {
  event: SubEvent & { id: string };
  userId: string | null;
  source: string;
  environment?: string;
  originalTransactionId?: string;
  productId?: string;
  periodEnd?: Date;
  raw?: unknown;
}

/** 记事件流水,返回第一次见到(真正插入)的事件 id;已经有的(重复上报、重发)不动 */
export async function recordEvents(db: Db, rows: EventRow[]): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const inserted = await db.insertInto("subscription_events")
    .values(rows.map((r) => ({
      id: r.event.id,
      user_id: r.userId,
      type: r.event.type,
      product_id: ("productId" in r.event && r.event.productId) || r.productId || null,
      at: r.event.at,
      source: r.source,
      raw: r.raw === undefined ? null : JSON.stringify(r.raw),
      original_transaction_id: r.originalTransactionId ?? null,
      period_end: r.periodEnd ?? null,
      event: JSON.stringify(r.event),
      environment: r.environment ?? null,
    })))
    .onConflict((oc) => oc.column("id").doNothing())
    .returning("id")
    .execute();
  return new Set(inserted.map((r) => r.id));
}

/**
 * 把还没对应到用户的、同一订阅的事件认领给这个用户,按发生顺序返回(要补应用)。
 * fromDeletedUser:换绑时原来那个已注销的账号——它名下还没去掉关联的流水(比如账号行被直接删掉)也一起认领。
 */
export async function claimOrphanEvents(
  db: Db, userId: string, originalTransactionId: string, fromDeletedUser?: string,
): Promise<{ event: SubEvent; periodEnd: Date | undefined }[]> {
  const rows = await db.updateTable("subscription_events").set({ user_id: userId })
    .where("original_transaction_id", "=", originalTransactionId)
    .where((eb) => (fromDeletedUser ? eb.or([eb("user_id", "is", null), eb("user_id", "=", fromDeletedUser)]) : eb("user_id", "is", null)))
    .returning(["event", "period_end", "at", "seq"])
    .execute();
  if (!rows.length) return [];
  await db.updateTable("apple_notifications").set({ user_id: userId })
    .where("original_transaction_id", "=", originalTransactionId)
    .where((eb) => (fromDeletedUser ? eb.or([eb("user_id", "is", null), eb("user_id", "=", fromDeletedUser)]) : eb("user_id", "is", null)))
    .execute();
  return rows
    .filter((r) => r.event)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || Number(a.seq) - Number(b.seq))
    .map((r) => ({ event: reviveEvent(r.event), periodEnd: r.period_end ?? undefined }));
}

const DATE_KEYS = new Set(["at", "periodEnd", "graceEnd"]);
function reviveEvent(json: unknown): SubEvent {
  const obj = (typeof json === "string" ? JSON.parse(json) : json) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, DATE_KEYS.has(k) && typeof v === "string" ? new Date(v) : v])) as SubEvent;
}

/** 记下一条通知;同一条通知(苹果重发)已经记过就返回 false */
export async function recordAppleNotification(db: Db, n: {
  id: string; type: string; subtype?: string; originalTransactionId?: string; userId: string | null; environment?: string; signedAt: Date; raw?: unknown;
}): Promise<boolean> {
  const rows = await db.insertInto("apple_notifications")
    .values({
      id: n.id, type: n.type, subtype: n.subtype ?? null, original_transaction_id: n.originalTransactionId ?? null,
      user_id: n.userId, environment: n.environment ?? null, signed_at: n.signedAt, raw: n.raw === undefined ? null : JSON.stringify(n.raw),
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .returning("id")
    .execute();
  return rows.length > 0;
}

/** 这个订阅(原始交易 id)现在绑定在谁名下;没有绑定返回 null(账号注销时绑定会被删掉) */
export async function bindingOwner(db: Db, originalTransactionId: string): Promise<string | null> {
  const row = await db.selectFrom("subscriptions").select("user_id").where("original_transaction_id", "=", originalTransactionId).executeTakeFirst();
  return row?.user_id ?? null;
}

/**
 * 还在用的账号(这一行还在、没有注销)按我们存的写法返回 id,否则 null。
 * 苹果给回来的 UUID 大小写可能和我们存的不一样,都试一下
 */
export async function activeUserId(db: Db, userId: string): Promise<string | null> {
  const row = await db.selectFrom("users").select("id")
    .where("id", "in", [...new Set([userId, userId.toLowerCase(), userId.toUpperCase()])]).where("deleted_at", "is", null)
    .executeTakeFirst();
  return row?.id ?? null;
}

/** 流水里这个订阅最近出现过的账号标识(苹果交易、续订信息里的 appAccountToken),新的在前 */
export async function recentAccountTokens(db: Db, originalTransactionId: string): Promise<string[]> {
  const rows = await db.selectFrom("subscription_events").select("raw")
    .where("original_transaction_id", "=", originalTransactionId).orderBy("seq", "desc").limit(50).execute();
  const out: string[] = [];
  for (const { raw } of rows) {
    const r = raw as { transaction?: { appAccountToken?: unknown }; renewal?: { appAccountToken?: unknown } } | null;
    for (const t of [r?.transaction?.appAccountToken, r?.renewal?.appAccountToken]) {
      if (typeof t === "string" && t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** 换绑时删掉原来主人名下的这个订阅(只删绑定在这个订阅上的那一行),免得一个订阅两个账号都是会员 */
export async function deleteBoundSubscription(db: Db, userId: string, originalTransactionId: string): Promise<void> {
  await db.deleteFrom("subscriptions").where("user_id", "=", userId).where("original_transaction_id", "=", originalTransactionId).execute();
}

/** 换绑记录里表示"已注销的账号"和"原来没有主人"(第一次认领)的写法 */
export const DELETED_USER = "deleted";
export const NO_OWNER = "none";

export async function recordRebind(db: Db, r: { originalTransactionId: string; oldUserId: string; newUserId: string; source: string; at: Date }): Promise<void> {
  await db.insertInto("subscription_rebinds")
    .values({ id: randomUUID(), original_transaction_id: r.originalTransactionId, old_user_id: r.oldUserId, new_user_id: r.newUserId, source: r.source, at: r.at })
    .execute();
}

/** 换绑记录里这个订阅最后归了谁(new_user_id;注销了的是 "deleted"),没有记录返回 null */
export async function lastRebindOwner(db: Db, originalTransactionId: string): Promise<string | null> {
  const row = await db.selectFrom("subscription_rebinds").select("new_user_id")
    .where("original_transaction_id", "=", originalTransactionId).orderBy("at", "desc").orderBy("id", "desc").executeTakeFirst();
  return row?.new_user_id ?? null;
}

/**
 * 注销账号时支付相关的清理(routes/account.ts 在注销的事务里调用):
 * 订阅状态删掉;交易流水、苹果通知保留(对账、退款、指标要用),但不再关联这个人;
 * 换绑记录里这个账号的 id 改成 "deleted"。同一个 Apple ID 以后在新账号恢复购买,按换绑规则接手。
 */
export async function forgetBillingUser(db: Db, userId: string): Promise<void> {
  await db.deleteFrom("subscriptions").where("user_id", "=", userId).execute();
  await db.updateTable("subscription_events").set({ user_id: null }).where("user_id", "=", userId).execute();
  await db.updateTable("apple_notifications").set({ user_id: null }).where("user_id", "=", userId).execute();
  await db.updateTable("subscription_rebinds").set({ old_user_id: DELETED_USER }).where("old_user_id", "=", userId).execute();
  await db.updateTable("subscription_rebinds").set({ new_user_id: DELETED_USER }).where("new_user_id", "=", userId).execute();
}

/**
 * 加锁(在事务里调用,事务结束自动释放):同一个订阅、同一个用户的更新排队进行——App 上报和苹果通知常常同时到,
 * 两个新账号也可能同时来认领同一个订阅。顺序固定为先订阅、后用户,不会互相等死。
 */
export async function lockOriginalTransaction(db: Db, originalTransactionId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`billing-otid:${originalTransactionId}`}))`.execute(db);
}

export async function lockUserSubscription(db: Db, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))`.execute(db);
}
