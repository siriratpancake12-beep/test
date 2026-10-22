import { PGlite } from "@electric-sql/pglite";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Config } from "../config";
import { migrateAi, type AiTables } from "./ai";
import { migrateBilling, type BillingTables } from "./billing";
import { migrateCore, type CoreTables } from "./core";
import { pglitePool } from "./pglite";

export interface Database extends CoreTables, BillingTables, AiTables {}
export type Db = Kysely<Database>;

export async function createDb(config: Config): Promise<Db> {
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl, max: 10 })
    : pglitePool(await PGlite.create(config.pgliteDir));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await migrate(db);
  return db;
}

/** 建表(可重复执行)。每个模块只建自己的表。 */
export async function migrate(db: Db): Promise<void> {
  await migrateCore(db);
  await migrateBilling(db);
  await migrateAi(db);
}
