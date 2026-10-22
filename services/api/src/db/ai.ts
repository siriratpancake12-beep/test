import { sql, type Kysely } from "kysely";
import type { Db } from "./index";

/**
 * AI 老师用量、发音评测用量的表。负责人:AI 与语音模块(server-ai)。
 *
 * 只记次数,不存对话内容和录音:《生成式人工智能服务管理暂行办法》要求不非法留存能识别用户身份的输入信息,
 * 我们也不需要它。按 UTC 日期一天一行,用来算每日额度和每月成本。
 */
export interface AiTables {
  ai_usage: {
    user_id: string;
    /** UTC 日期 YYYY-MM-DD(用文本存,避免数据库驱动把日期转成本地时区) */
    day: string;
    /** tutor:AI 老师回复一次;speech:发音评测一次 */
    kind: string;
    count: number;
  };
}

export type AiKind = "tutor" | "speech";

export async function migrateAi(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ai_usage")
    .ifNotExists()
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("day", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("count", "integer", (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint("ai_usage_pk", ["user_id", "day", "kind"])
    .execute();
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 先占用一次额度(加 1),没超过上限返回加完后的次数,超过了返回 null。
 * 用一条 upsert 完成"检查 + 加 1",同一个用户同时发几个请求也不会超额。
 * 调用外部服务失败时用 releaseQuota 退回,失败不算次数。
 */
export async function takeQuota(db: Db, userId: string, day: string, kind: AiKind, limit: number): Promise<number | null> {
  if (limit <= 0) return null;
  const row = await db
    .insertInto("ai_usage")
    .values({ user_id: userId, day, kind, count: 1 })
    .onConflict((oc) =>
      oc.columns(["user_id", "day", "kind"]).doUpdateSet({ count: sql<number>`ai_usage.count + 1` }).where("ai_usage.count", "<", limit),
    )
    .returning("count")
    .executeTakeFirst();
  return row ? row.count : null;
}

export async function releaseQuota(db: Db, userId: string, day: string, kind: AiKind): Promise<void> {
  await db
    .updateTable("ai_usage")
    .set({ count: sql<number>`greatest(count - 1, 0)` })
    .where("user_id", "=", userId)
    .where("day", "=", day)
    .where("kind", "=", kind)
    .execute();
}

/** 注销账号时删掉这个用户的用量记录(给 server-core 的注销流程调用)。 */
export async function deleteAiUsage(db: Db, userId: string): Promise<void> {
  await db.deleteFrom("ai_usage").where("user_id", "=", userId).execute();
}
