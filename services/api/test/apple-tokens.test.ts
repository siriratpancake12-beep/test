import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { AuthResult, ROUTES } from "@lingo/core";
import { testConfig } from "../src/config";
import { APPLE_REVOKE_URL, APPLE_TOKEN_URL, AppleTokenError, createAppleTokenClient, normalizePem, type AppleSignInKey } from "../src/auth/apple-tokens";
import { createAppleTokens, type AppleIdVerifier } from "../src/routes/auth";
import { makeTestApp, type TestApp } from "./helpers";

/** 测试用的 Sign in with Apple 私钥(现场生成,和苹果给的 .p8 一样是 PKCS#8 PEM) */
const pair = await generateKeyPair("ES256", { extractable: true });
const pem = await exportPKCS8(pair.privateKey);
const KEY: AppleSignInKey = { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: pem, clientId: "com.example.lingocn" };
const NOW = new Date("2026-11-01T12:00:00Z");

interface Call { url: string; form: URLSearchParams; headers: Record<string, string> }
/** 假的 fetch:记下请求,按 reply 回答;不访问外网 */
function fakeFetch(reply: (url: string, form: URLSearchParams) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const form = new URLSearchParams(String(init.body));
    calls.push({ url, form, headers: init.headers as Record<string, string> });
    return reply(url, form);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** 苹果在换令牌的响应里给的 id_token(这里只关心 sub,签名无所谓) */
const idToken = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(sub).sign(new TextEncoder().encode("x"));

/** client_secret:用公钥验签,核对苹果要求的各项 */
async function checkSecret(secret: string) {
  expect(decodeProtectedHeader(secret)).toEqual({ alg: "ES256", kid: KEY.keyId });
  const { payload } = await jwtVerify(secret, pair.publicKey, { issuer: KEY.teamId, subject: KEY.clientId, audience: "https://appleid.apple.com", currentDate: NOW });
  expect(payload.exp! - payload.iat!).toBe(300);
  expect(payload.iat).toBe(NOW.getTime() / 1000);
}

describe("Sign in with Apple 令牌接口", () => {
  it("用授权码换刷新令牌:表单字段齐全,client_secret 是我们私钥签的 ES256 JWT", async () => {
    const f = fakeFetch(() => json({ access_token: "at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", id_token: "" }));
    const client = createAppleTokenClient(KEY, f.fn, () => NOW);
    expect(await client.exchangeCode("auth-code")).toEqual({ refreshToken: "rt-1", sub: undefined });
    const call = f.calls[0]!;
    expect(call.url).toBe(APPLE_TOKEN_URL);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(call.form)).toMatchObject({ client_id: KEY.clientId, code: "auth-code", grant_type: "authorization_code" });
    await checkSecret(call.form.get("client_secret")!);
  });

  it("响应里的 id_token 给出苹果用户 id,用来核对授权码是不是本人的", async () => {
    const token = await idToken("apple-user-9");
    const f = fakeFetch(() => json({ refresh_token: "rt-2", id_token: token }));
    expect(await createAppleTokenClient(KEY, f.fn, () => NOW).exchangeCode("c")).toEqual({ refreshToken: "rt-2", sub: "apple-user-9" });
  });

  it("撤销:发到 revoke 接口,带刷新令牌和类型", async () => {
    const f = fakeFetch(() => new Response("", { status: 200 }));
    await createAppleTokenClient(KEY, f.fn, () => NOW).revoke("rt-3");
    const call = f.calls[0]!;
    expect(call.url).toBe(APPLE_REVOKE_URL);
    expect(Object.fromEntries(call.form)).toMatchObject({ client_id: KEY.clientId, token: "rt-3", token_type_hint: "refresh_token" });
    await checkSecret(call.form.get("client_secret")!);
  });

  it("苹果返回错误时抛出 AppleTokenError(授权码过期、密钥配错、没给刷新令牌)", async () => {
    const make = (r: Response) => createAppleTokenClient(KEY, fakeFetch(() => r).fn, () => NOW);
    await expect(make(json({ error: "invalid_grant" }, 400)).exchangeCode("old")).rejects.toMatchObject({ status: 400, error: "invalid_grant" });
    await expect(make(json({ access_token: "at" })).exchangeCode("c")).rejects.toMatchObject({ error: "no_refresh_token" });
    await expect(make(json({ error: "invalid_client" }, 401)).revoke("rt")).rejects.toBeInstanceOf(AppleTokenError);
    await expect(make(new Response("<html>bad gateway</html>", { status: 502 })).revoke("rt")).rejects.toMatchObject({ status: 502 });
  });

  it("环境变量里的私钥:换行写成 \\n、只给中间的 base64,都能用", async () => {
    expect(normalizePem(pem.replace(/\n/g, "\\n"))).toBe(pem.trim());
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
    for (const privateKey of [pem.replace(/\n/g, "\\n"), body]) {
      const f = fakeFetch(() => new Response("", { status: 200 }));
      await createAppleTokenClient({ ...KEY, privateKey }, f.fn, () => NOW).revoke("rt");
      await checkSecret(f.calls[0]!.form.get("client_secret")!);
    }
  });

  it("按配置创建:三项密钥都配了才开", () => {
    const base = testConfig();
    expect(createAppleTokens(base)).toBeNull();
    expect(createAppleTokens({ ...base, apple: { ...base.apple, teamId: "T", signInKeyId: "K" } })).toBeNull();
    expect(createAppleTokens({ ...base, apple: { ...base.apple, teamId: "T", signInKeyId: "K", signInPrivateKey: pem } })).not.toBeNull();
  });
});

describe("登录带授权码 → 存刷新令牌 → 注销时撤销(真实的令牌接口 + 假的 fetch)", () => {
  let t: TestApp;
  const apple: AppleIdVerifier = { async verify(token) { return { sub: token }; } };
  // 苹果:授权码 "code-<sub>" 换出 "rt-<sub>";撤销都成功
  const f = fakeFetch((url, form) => {
    if (url === APPLE_REVOKE_URL) return new Response("", { status: 200 });
    const sub = form.get("code")!.replace(/^code-/, "");
    return json({ refresh_token: `rt-${sub}`, id_token: tokens.get(sub) });
  });
  const tokens = new Map<string, string>();
  beforeAll(async () => {
    for (const sub of ["apple-alice", "apple-bob"]) tokens.set(sub, await idToken(sub));
    t = await makeTestApp({ apple, appleTokens: createAppleTokenClient(KEY, f.fn, () => NOW) });
  }, 60_000);
  afterAll(async () => t?.app.close());
  const login = async (identityToken: string, authorizationCode?: string) =>
    t.app.inject({ method: "POST", url: ROUTES.appleLogin, payload: { identityToken, ...(authorizationCode ? { authorizationCode } : {}) } });
  const refreshOf = async (id: string) => (await t.deps.db.selectFrom("users").select("apple_refresh_token").where("id", "=", id).executeTakeFirstOrThrow()).apple_refresh_token;

  it("登录时换到的刷新令牌存起来,注销时拿它撤销", async () => {
    const me = AuthResult.parse((await login("apple-alice", "code-apple-alice")).json());
    expect(await refreshOf(me.user.id)).toBe("rt-apple-alice");
    const r = await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: { authorization: `Bearer ${me.token}` } });
    expect(r.statusCode).toBe(204);
    const revokes = f.calls.filter((c) => c.url === APPLE_REVOKE_URL);
    expect(revokes.map((c) => c.form.get("token"))).toEqual(["rt-apple-alice"]);
  });

  it("授权码不是这个苹果账号的:不保存;换不到令牌:登录照常成功", async () => {
    const me = AuthResult.parse((await login("apple-carol", "code-apple-bob")).json());
    expect(await refreshOf(me.user.id)).toBeNull();
    const failing = await makeTestApp({
      db: t.deps.db,
      apple,
      appleTokens: createAppleTokenClient(KEY, fakeFetch(() => json({ error: "invalid_grant" }, 400)).fn, () => NOW),
    });
    const r = await failing.app.inject({ method: "POST", url: ROUTES.appleLogin, payload: { identityToken: "apple-dave", authorizationCode: "expired" } });
    expect(r.statusCode).toBe(200);
    expect(await refreshOf(AuthResult.parse(r.json()).user.id)).toBeNull();
    await failing.app.close();
  });

  it("苹果很慢时登录不等它:先返回登录结果,令牌在后台存好", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowFetch = (async () => {
      await gate;
      return json({ refresh_token: "rt-slow" });
    }) as unknown as typeof fetch;
    const slow = await makeTestApp({ db: t.deps.db, apple, appleTokens: createAppleTokenClient(KEY, slowFetch, () => NOW) });
    const started = Date.now();
    const r = await slow.app.inject({ method: "POST", url: ROUTES.appleLogin, payload: { identityToken: "apple-slow-user", authorizationCode: "code-x" } });
    expect(r.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    const id = AuthResult.parse(r.json()).user.id;
    expect(await refreshOf(id)).toBeNull();
    release();
    await vi.waitFor(async () => expect(await refreshOf(id)).toBe("rt-slow"));
    await slow.app.close();
  });
});
