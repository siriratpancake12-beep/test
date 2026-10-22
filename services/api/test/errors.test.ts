import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError, frameworkErrors, installErrorHandler } from "../src/errors";

/** 不需要数据库:一个只装了统一错误处理的小服务器(和 app.ts 一样传 frameworkErrors) */
let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ logger: false, bodyLimit: 1024, frameworkErrors });
  installErrorHandler(app);
  app.post("/echo", async (req) => ({ got: req.body }));
  app.get("/item/:id", async (req) => (req.params as { id: string }).id);
  app.get("/http-error", async () => {
    throw new HttpError(409, "conflict", "已经有了");
  });
  app.get("/zod", async () => z.object({ phone: z.string().min(11, "请输入正确的手机号") }).parse({ phone: "1" }));
  app.get("/boom", async () => {
    throw new Error("数据库连接串 postgres://secret@db 不对");
  });
  await app.ready();
});
afterAll(async () => app?.close());

const post = (payload: string, contentType: string) => app.inject({ method: "POST", url: "/echo", headers: { "content-type": contentType }, payload });

describe("统一错误格式", () => {
  it("业务错误、zod 校验错误:原样给出中文提示", async () => {
    expect((await app.inject({ method: "GET", url: "/http-error" })).json()).toEqual({ error: { code: "conflict", message: "已经有了" } });
    const z400 = await app.inject({ method: "GET", url: "/zod" });
    expect(z400.statusCode).toBe(400);
    expect(z400.json()).toEqual({ error: { code: "invalid", message: "请输入正确的手机号" } });
  });

  it("服务器内部错误:不把内部信息给用户看", async () => {
    const r = await app.inject({ method: "GET", url: "/boom" });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: "internal", message: "服务器出错了,请稍后再试" } });
  });

  it("Fastify 自己的 4xx 换成中文:不是合法 JSON、空的 JSON、格式不支持、太大", async () => {
    const bad = await post("{not json", "application/json");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: { code: "invalid_json", message: "请求内容不是合法的 JSON" } });
    // 原型污染也按"不是合法的 JSON"拒绝
    expect((await post('{"__proto__":{"admin":true}}', "application/json")).json().error.code).toBe("invalid_json");
    const empty = await post("", "application/json");
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: { code: "empty_body", message: "请求内容不能为空" } });
    const media = await post("a=1", "application/x-www-form-urlencoded");
    expect(media.statusCode).toBe(415);
    expect(media.json()).toEqual({ error: { code: "unsupported_media_type", message: "不支持这种请求格式" } });
    const big = await post(JSON.stringify({ x: "y".repeat(2000) }), "application/json");
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: { code: "body_too_large", message: "上传的内容太大了" } });
    // 正常的请求不受影响
    expect((await post('{"a":1}', "application/json")).json()).toEqual({ got: { a: 1 } });
  });

  it("地址格式不对、找不到接口:也是统一格式的中文", async () => {
    const badUrl = await app.inject({ method: "GET", url: "/item/%E0%A4%A" });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json()).toEqual({ error: { code: "bad_url", message: "请求地址不对" } });
    const missing = await app.inject({ method: "GET", url: "/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "找不到这个接口" } });
  });
});
