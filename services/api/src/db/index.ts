import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Config } from "../config";
import { migrateAi, type AiTables } from "./ai";
import { migrateBilling, type BillingTables } from "./billing";
import { migrateCore, type CoreTables } from "./core";
import { migrateJobs, type JobTables } from "./jobs";
import { pglitePool } from "./pglite";

export interface Database extends CoreTables, BillingTables, AiTables, JobTables {}
export type Db = Kysely<Database>;

export async function createDb(config: Config): Promise<Db> {
  let pool;
  if (config.databaseUrl) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  } else {
    // PGlite 只会建最后一级目录:上级目录(比如新检出仓库里还没有的 ./data)不存在时会启动失败,先建好
    const dir = pgliteFsDir(config.pgliteDir);
    if (dir) mkdirSync(dir, { recursive: true });
    pool = pglitePool(await PGlite.create(config.pgliteDir));
  }
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await migrate(db);
  return db;
}

/** PGlite 数据目录对应的本机路径;memory://(内存)、idb:// 这类不是本机目录,返回 null */
export function pgliteFsDir(dataDir: string): string | null {
  if (dataDir.startsWith("file://")) return dataDir.slice("file://".length) || null;
  return dataDir.includes("://") ? null : dataDir;
}

/** 建表(可重复执行)。每个模块只建自己的表。 */
export async function migrate(db: Db): Promise<void> {
  await migrateCore(db);
  await migrateBilling(db);
  await migrateAi(db);
  await migrateJobs(db);
}
