import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
// 建服务器(含数据库)放在 beforeAll:用例本身只算请求的时间,机器忙时也不会因为启动慢而超时
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => t?.app.close());

describe("服务器", () => {
  it("健康检查,数据库可用", async () => {
    const r = await t.app.inject({ method: "GET", url: "/v1/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, time: "2026-11-01T12:00:00.000Z" });
    const rows = await sql<{ n: number }>`select 1 + 1 as n`.execute(t.deps.db);
    expect(rows.rows[0]?.n).toBe(2);
  });

  it("统一的错误格式", async () => {
    const r = await t.app.inject({ method: "GET", url: "/v1/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: "not_found", message: "找不到这个接口" } });
  });
});
