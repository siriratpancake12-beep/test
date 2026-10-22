import type { PGlite } from "@electric-sql/pglite";
import type { PostgresPool, PostgresPoolClient, PostgresQueryResult } from "kysely";

/**
 * 让 Kysely 的 Postgres 驱动用 PGlite(编译成 WebAssembly 的真 Postgres)。开发和测试用它,
 * 不用装数据库;生产用真正的 Postgres(pg)。两边是同一种 SQL,测试结果可信。
 *
 * PGlite 只有一个连接,所以用队列保证同一时间只有一个"连接"在用,事务不会互相穿插。
 */
export function pglitePool(pg: PGlite): PostgresPool {
  let tail: Promise<void> = Promise.resolve();
  return {
    options: {},
    async connect(): Promise<PostgresPoolClient> {
      let release!: () => void;
      const prev = tail;
      tail = new Promise<void>((r) => (release = r));
      await prev;
      const client = {
        async query<R>(sql: string, params: ReadonlyArray<unknown>): Promise<PostgresQueryResult<R>> {
          const r = await pg.query<R>(sql, params as unknown[]);
          return { command: commandOf(sql), rowCount: r.affectedRows ?? r.rows.length, rows: r.rows };
        },
        release,
        end() {},
      };
      return client as unknown as PostgresPoolClient;
    },
    async end() {
      await pg.close();
    },
  };
}

function commandOf(sql: string): PostgresQueryResult<unknown>["command"] {
  const w = sql.trimStart().split(/\s+/, 1)[0]!.toUpperCase();
  if (w === "INSERT" || w === "UPDATE" || w === "DELETE" || w === "MERGE") return w;
  // with ... insert/update 这类也按影响行数处理
  if (w === "WITH") {
    const m = sql.match(/\)\s*(INSERT|UPDATE|DELETE)\b/i);
    if (m) return m[1]!.toUpperCase() as "INSERT" | "UPDATE" | "DELETE";
  }
  return "SELECT";
}
