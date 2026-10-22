import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createRemoteJWKSet, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { AuthResult, ROUTES } from "@lingo/core";
import { buildApp } from "../src/app";
import { testConfig } from "../src/config";
import { APPLE_ISSUER, AppleUnavailableError, createAppleIdVerifier } from "../src/auth/apple";
import { WechatError, createWechatClient } from "../src/auth/wechat";
import { createAuthProviders, type AppleIdVerifier } from "../src/routes/auth";
import { makeTestApp, type TestApp } from "./helpers";

const BUNDLE = "com.example.lingocn";

/** 本机起一个假的苹果公钥服务(JWKS),不访问外网 */
let jwks: Server;
let jwksUrl: URL;
let appleKey: CryptoKey;
let strangerKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  appleKey = pair.privateKey;
  strangerKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "apple-test-key", alg: "RS256", use: "sig" };
  jwks = createServer((req, res) => {
    if (req.url !== "/auth/keys") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
  jwksUrl = new URL(`http://127.0.0.1:${(jwks.address() as AddressInfo).port}/auth/keys`);
});
afterAll(() => new Promise<void>((r) => jwks.close(() => r())));

/**
 * 整个文件共用一个数据库(建一个 PGlite 要一两秒):t 的 Apple、微信服务在各个测试里替换;
 * off 是同一个数据库上另起的、什么登录服务都没配置的服务器。
 */
let t: TestApp;
let off: FastifyInstance;
let apple: AppleIdVerifier = { async verify() { throw new Error("没设置"); } };
let next: () => Promise<{ openid: string; unionid?: string }> = async () => { throw new Error("没设置"); };
beforeAll(async () => {
  t = await makeTestApp({ apple: { verify: (tok) => apple.verify(tok) }, wechat: { exchange: () => next() } });
  off = await buildApp({ ...t.deps, apple: null, wechat: null });
}, 60_000);
afterAll(async () => {
  await off?.close();
  await t?.app.close();
});

interface TokenOpts { iss?: string; aud?: string; sub?: string; exp?: number | string; key?: CryptoKey; kid?: string }
const appleToken = (o: TokenOpts = {}) => {
  const jwt = new SignJWT({ email: "abc@privaterelay.appleid.com", email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "apple-test-key" })
    .setIssuer(o.iss ?? APPLE_ISSUER)
    .setAudience(o.aud ?? BUNDLE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "10m");
  if (o.sub !== "") jwt.setSubject(o.sub ?? "001234.abcdef.1234");
  return jwt.sign(o.key ?? appleKey);
};

describe("Sign in with Apple:校验 identityToken", () => {
  const verifier = () => createAppleIdVerifier(BUNDLE, createRemoteJWKSet(jwksUrl));

  it("苹果签名、给我们 App 的、没过期:取出苹果用户 id", async () => {
    expect(await verifier().verify(await appleToken())).toEqual({ sub: "001234.abcdef.1234", email: "abc@privaterelay.appleid.com" });
  });

  it("受众不是我们的 bundleId、签发方不是苹果、过期、别人的私钥签的、没有 sub:都拒绝", async () => {
    const v = verifier();
    const bad = [
      await appleToken({ aud: "com.other.app" }),
      await appleToken({ iss: "https://evil.example.com" }),
      await appleToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await appleToken({ key: strangerKey }),
      await appleToken({ kid: "unknown-kid" }),
      await appleToken({ sub: "" }),
      "not-a-jwt-at-all",
    ];
    for (const tok of bad) {
      const err = await v.verify(tok).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppleUnavailableError);
    }
  });

  it("连不上苹果的公钥服务:报'暂时不可用',不是'登录失败'", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const v = createAppleIdVerifier(BUNDLE, createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/auth/keys`)));
    await expect(v.verify(await appleToken())).rejects.toBeInstanceOf(AppleUnavailableError);
  });
});

describe("Apple 登录接口", () => {
  const post = (identityToken: string) => t.app.inject({ method: "POST", url: ROUTES.appleLogin, payload: { identityToken } });

  it("新用户注册、老用户登录;token 无效时 401", async () => {
    apple = createAppleIdVerifier(BUNDLE, createRemoteJWKSet(jwksUrl));
    const first = AuthResult.parse((await post(await appleToken({ sub: "apple-user-1" }))).json());
    expect(first).toMatchObject({ isNew: true, user: { phone: null, hasApple: true, hasWechat: false } });
    const second = AuthResult.parse((await post(await appleToken({ sub: "apple-user-1" }))).json());
    expect(second).toMatchObject({ isNew: false, user: { id: first.user.id } });

    const bad = await post(await appleToken({ aud: "com.other.app" }));
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toEqual({ code: "apple_invalid", message: "Apple 登录验证失败,请重试" });
    const short = await post("abc");
    expect(short.statusCode).toBe(400);
    expect(short.json().error.message).toBe("Apple 登录信息不完整,请重试");
  });

  it("连不上苹果时 503;没配置时提示暂不支持", async () => {
    apple = { async verify() { throw new AppleUnavailableError("timeout"); } };
    const r = await post("x".repeat(20));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toBe("暂时连不上 Apple,请稍后再试");

    const r2 = await off.inject({ method: "POST", url: ROUTES.appleLogin, payload: { identityToken: "x".repeat(20) } });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toEqual({ code: "login_unavailable", message: "暂不支持 Apple 登录" });
  });
});

describe("微信:用 code 换身份", () => {
  const reply = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "text/plain" } });

  it("请求微信接口时带上 appid、secret、code,返回 openid / unionid", async () => {
    let called = "";
    const client = createWechatClient("wx-app", "wx-secret", (async (url: string) => {
      called = url;
      return reply({ access_token: "AT", expires_in: 7200, refresh_token: "RT", openid: "o-1", scope: "snsapi_userinfo", unionid: "u-1" });
    }) as unknown as typeof fetch);
    expect(await client.exchange("CODE")).toEqual({ openid: "o-1", unionid: "u-1" });
    const u = new URL(called);
    expect(u.origin + u.pathname).toBe("https://api.weixin.qq.com/sns/oauth2/access_token");
    expect(Object.fromEntries(u.searchParams)).toEqual({ appid: "wx-app", secret: "wx-secret", code: "CODE", grant_type: "authorization_code" });
  });

  it("微信返回错误码(HTTP 仍是 200)时抛出 WechatError;code 无效、已用、过期算 invalidCode", async () => {
    const make = (r: Response) => createWechatClient("a", "b", (async () => r) as unknown as typeof fetch);
    const e1 = await make(reply({ errcode: 40029, errmsg: "invalid code" })).exchange("x").catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(WechatError);
    expect((e1 as WechatError).invalidCode).toBe(true);
    const e2 = await make(reply({ errcode: 40163, errmsg: "code been used" })).exchange("x").catch((e: unknown) => e);
    expect((e2 as WechatError).invalidCode).toBe(true);
    const e3 = await make(reply({ errcode: -1, errmsg: "system error" })).exchange("x").catch((e: unknown) => e);
    expect((e3 as WechatError).invalidCode).toBe(false);
    await expect(make(reply("oops", 500)).exchange("x")).rejects.toBeInstanceOf(WechatError);
    await expect(make(reply("not json")).exchange("x")).rejects.toBeInstanceOf(WechatError);
  });
});

describe("微信登录接口", () => {
  const post = (code = "CODE") => t.app.inject({ method: "POST", url: ROUTES.wechatLogin, payload: { code } });

  it("按 unionid 认人:第一次注册,之后登录同一个账号", async () => {
    next = async () => ({ openid: "o-a", unionid: "u-a" });
    const first = AuthResult.parse((await post()).json());
    expect(first).toMatchObject({ isNew: true, user: { hasWechat: true, hasApple: false, phone: null } });
    const again = AuthResult.parse((await post()).json());
    expect(again).toMatchObject({ isNew: false, user: { id: first.user.id } });
  });

  it("以前只拿到 openid 的账号,之后拿到 unionid 也认得,并补上 unionid", async () => {
    next = async () => ({ openid: "o-b" });
    const first = AuthResult.parse((await post()).json());
    next = async () => ({ openid: "o-b", unionid: "u-b" });
    const again = AuthResult.parse((await post()).json());
    expect(again.user.id).toBe(first.user.id);
    const row = await t.deps.db.selectFrom("users").selectAll().where("id", "=", first.user.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ wechat_openid: "o-b", wechat_unionid: "u-b" });
  });

  it("code 失效时 401,微信出错时 502", async () => {
    next = async () => { throw new WechatError(40163, "code been used"); };
    const r1 = await post();
    expect(r1.statusCode).toBe(401);
    expect(r1.json().error).toEqual({ code: "wechat_invalid", message: "微信授权已失效,请重新登录" });
    next = async () => { throw new Error("network"); };
    const r2 = await post();
    expect(r2.statusCode).toBe(502);
    expect(r2.json().error.message).toBe("微信登录暂时不可用,请稍后再试");
    expect((await t.app.inject({ method: "POST", url: ROUTES.wechatLogin, payload: {} })).json().error.message).toBe("微信登录信息不完整,请重试");
  });

  it("没配置 appId / secret 时接口提示暂不支持", async () => {
    const r = await off.inject({ method: "POST", url: ROUTES.wechatLogin, payload: { code: "x" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: "login_unavailable", message: "暂不支持微信登录" });
  });
});

describe("按配置创建登录服务", () => {
  it("Apple 总是开着;微信要配了 appId 和 secret 才开", () => {
    const base = testConfig();
    expect(createAuthProviders(base).apple).not.toBeNull();
    expect(createAuthProviders(base).wechat).toBeNull();
    expect(createAuthProviders({ ...base, wechat: { appId: "wx" } }).wechat).toBeNull();
    expect(createAuthProviders({ ...base, wechat: { appId: "wx", appSecret: "s" } }).wechat).not.toBeNull();
  });
});
