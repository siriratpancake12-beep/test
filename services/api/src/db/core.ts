import { sql, type Kysely } from "kysely";

/**
 * 账号、登录、进度、埋点的表。负责人:服务器主体(server-core)。
 * 其他模块的表在 billing.ts、ai.ts。迁移按 core → billing → ai 的顺序执行。
 */
export interface CoreTables {
  users: {
    id: string;
    phone: string | null;
    apple_sub: string | null;
    wechat_unionid: string | null;
    created_at: Date;
    deleted_at: Date | null;
  };
}

export async function migrateCore(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("phone", "text", (c) => c.unique())
    .addColumn("apple_sub", "text", (c) => c.unique())
    .addColumn("wechat_unionid", "text", (c) => c.unique())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .execute();
}
