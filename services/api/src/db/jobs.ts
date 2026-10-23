import type { Kysely } from "kysely";
import type { Db } from "./index";

/**
 * 定时任务的表。负责人:server-core。任务本身在 src/jobs/。
 * - job_runs:每个任务每个时段只跑一次(几台服务器各有定时器,谁先占到这个时段谁跑);
 *   同时是"保存期限真的执行了"的记录:哪天跑的、删了多少行(只有条数,没有个人信息)
 * - renewal_sms:扣费前提醒短信,每个账号每一期最多一条
 */
export interface JobTables {
  job_runs: {
    name: string;
    /** 时段:清理按天,扣费提醒按小时(见 jobs/index.ts);命令行手动跑的是 cli:<时间> */
    slot: string;
    started_at: Date;
    finished_at: Date | null;
    /** true 成功、false 出错、null 还在跑(或者跑的时候服务器停了) */
    ok: boolean | null;
    /** 结果(各类删了几行、发了几条)或错误信息 */
    result: unknown;
  };
  renewal_sms: {
    id: string;
    /** 注销账号时置空:记录留作"提醒过"的凭据,按交易记录的期限(3 年)清理 */
    user_id: string | null;
    original_transaction_id: string | null;
    /** 这一期的到期时间,也就是自动续费的时间。和 user_id 一起唯一:每个账号每一期最多一条 */
    period_end: Date;
    /** 短信里写的商品和价格(下一期要扣费的那个) */
    product_id: string;
    price_cny: number;
    /**
     * sending:正在发(发的时候服务器停了也停在这里,不再重发,宁可少一条也不重复);sent:发出去了;
     * failed:确定没发出去(短信服务商报错、连不上),下一轮再试;unknown:超时,可能已经发出,不再重发
     */
    status: string;
    attempts: number;
    /** 出错时的错误码(不含手机号) */
    error: string | null;
    created_at: Date;
    updated_at: Date;
    sent_at: Date | null;
  };
}

export async function migrateJobs(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("job_runs")
    .ifNotExists()
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("slot", "text", (c) => c.notNull())
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("finished_at", "timestamptz")
    .addColumn("ok", "boolean")
    .addColumn("result", "jsonb")
    .addPrimaryKeyConstraint("job_runs_pkey", ["name", "slot"])
    .execute();
  await db.schema.createIndex("job_runs_started_at").ifNotExists().on("job_runs").column("started_at").execute();

  await db.schema
    .createTable("renewal_sms")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text")
    .addColumn("original_transaction_id", "text")
    .addColumn("period_end", "timestamptz", (c) => c.notNull())
    .addColumn("product_id", "text", (c) => c.notNull())
    .addColumn("price_cny", "integer", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("error", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .addColumn("sent_at", "timestamptz")
    .execute();
  // 每个账号每一期只有一行(几台服务器同时发也只有一台占得到);user_id 置空后不再参与唯一约束
  await db.schema.createIndex("renewal_sms_user_period").ifNotExists().unique().on("renewal_sms").columns(["user_id", "period_end"]).execute();
  await db.schema.createIndex("renewal_sms_period_end").ifNotExists().on("renewal_sms").column("period_end").execute();
}

/** 注销账号时调用(routes/account.ts 的注销事务里):提醒记录留下当凭据,但不再关联这个人 */
export async function forgetRenewalSms(db: Db, userId: string): Promise<void> {
  await db.updateTable("renewal_sms").set({ user_id: null }).where("user_id", "=", userId).execute();
}

/** 占一个任务时段:占到了返回 true(这一台去跑);已经有人占了返回 false */
export async function claimJobSlot(db: Db, name: string, slot: string, now: Date): Promise<boolean> {
  const row = await db.insertInto("job_runs")
    .values({ name, slot, started_at: now, finished_at: null, ok: null, result: null })
    .onConflict((oc) => oc.columns(["name", "slot"]).doNothing())
    .returning("name")
    .executeTakeFirst();
  return !!row;
}

export async function finishJobSlot(db: Db, name: string, slot: string, now: Date, ok: boolean, result: unknown): Promise<void> {
  await db.updateTable("job_runs")
    .set({ finished_at: now, ok, result: JSON.stringify(result ?? null) })
    .where("name", "=", name).where("slot", "=", slot)
    .execute();
}
