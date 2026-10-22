import { sql, type Kysely } from "kysely";

/**
 * 订阅、交易记录的表。负责人:支付模块(billing)。
 * 后台指标(试用转付费、续费率、退款率)读 subscription_events,列名不要改(可以加列)。
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
    raw: unknown;
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
  await db.schema.createIndex("subscription_events_type_at").ifNotExists().on("subscription_events").columns(["type", "at"]).execute();
}
