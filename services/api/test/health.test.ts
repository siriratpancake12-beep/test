import { afterAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
afterAll(async () => t?.app.close());

describe("服务器", () => {
  it("健康检查,数据库可用", async () => {
    t = await makeTestApp();
    const r = await t.app.inject({ method: "GET", url: "/v1/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, time: "2026-11-01T12:00:00.000Z" });
    const rows = await sql<{ n: number }>`select 1 + 1 as n`.execute(t.deps.db);
    expect(rows.rows[0]?.n).toBe(2);
  });

  it("统一的错误格式", async () => {
    const r = await t.app.inject({ method: "GET", url: "/v1/nope" });
    expect(r.statusCode).toBe(404);
  });
});
