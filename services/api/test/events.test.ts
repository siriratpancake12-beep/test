import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type AppEvent } from "@lingo/core";
import { createUser, makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
// 建 PGlite 要一两秒,几个测试文件并行时更慢,给足时间
beforeAll(async () => {
  t = await makeTestApp();
}, 60_000);
afterAll(async () => t?.app.close());

let seq = 0;
const ev = (over: Partial<AppEvent> = {}): AppEvent => ({
  id: `ev_${String(++seq).padStart(8, "0")}`,
  name: "lesson_complete",
  at: "2026-11-01T11:30:00.000Z",
  anonId: "anon_device_1",
  lang: "de",
  props: { lessonId: "de.a1u1.l01", correct: 8, total: 10, seconds: 420 },
  platform: "ios",
  appVersion: "1.0.0",
  ...over,
});
const post = (events: unknown[], headers: Record<string, string> = {}) => t.app.inject({ method: "POST", url: ROUTES.events, payload: { events }, headers });
const rows = (ids: string[]) => t.deps.db.selectFrom("events").selectAll().where("id", "in", ids).orderBy("id").execute();

describe("埋点上传", () => {
  it("没登录也能传:记客户端时间和服务器收到的时间,user_id 为空", async () => {
    const batch = [ev(), ev({ name: "app_open", props: {} })];
    const r = await post(batch);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ accepted: 2 });
    const saved = await rows(batch.map((e) => e.id));
    expect(saved.map((s) => ({ ...s, at: new Date(s.at).toISOString(), received_at: new Date(s.received_at).toISOString() }))).toEqual([
      { id: batch[0]!.id, user_id: null, anon_id: "anon_device_1", name: "lesson_complete", at: "2026-11-01T11:30:00.000Z", received_at: "2026-11-01T12:00:00.000Z", lang: "de", props: batch[0]!.props, platform: "ios", app_version: "1.0.0" },
      { id: batch[1]!.id, user_id: null, anon_id: "anon_device_1", name: "app_open", at: "2026-11-01T11:30:00.000Z", received_at: "2026-11-01T12:00:00.000Z", lang: "de", props: {}, platform: "ios", app_version: "1.0.0" },
    ]);
  });

  it("登录了就记 user_id", async () => {
    const u = await createUser(t);
    const e = ev();
    expect((await post([e], u.headers)).json()).toEqual({ accepted: 1 });
    expect((await rows([e.id]))[0]!.user_id).toBe(u.userId);
  });

  it("按事件 id 去重:重试上传不重复计数,同一批里重复的也只记一次", async () => {
    const a = ev(), b = ev();
    expect((await post([a, b])).json()).toEqual({ accepted: 2 });
    expect((await post([a, b])).json()).toEqual({ accepted: 0 });
    const c = ev();
    expect((await post([a, c, c])).json()).toEqual({ accepted: 1 });
    expect(await rows([a.id, b.id, c.id])).toHaveLength(3);
  });

  it("格式不对:400 中文提示(空的、超过 200 条、事件名不认识、属性值太长)", async () => {
    for (const bad of [[], Array.from({ length: 201 }, () => ev()), [{ ...ev(), name: "hack" }], [ev({ props: { text: "x".repeat(201) } })]]) {
      const r = await post(bad);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toBe("埋点数据格式不对");
    }
    expect((await t.app.inject({ method: "POST", url: ROUTES.events })).statusCode).toBe(400);
  });

  it("带了无效的 token:401(可选登录不等于不检查)", async () => {
    const r = await post([ev()], { authorization: "Bearer not-a-token" });
    expect(r.statusCode).toBe(401);
  });
});
