import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES } from "@lingo/core";
import { buildApp } from "../src/app";
import { DEFAULT_TRUST_PROXY, loadConfig, parseTrustProxy, testConfig } from "../src/config";
import { createDb, pgliteFsDir } from "../src/db";
import { makeTestApp, type TestApp } from "./helpers";

describe("配置", () => {
  it("TRUST_PROXY 的几种写法", () => {
    expect(parseTrustProxy(undefined)).toEqual(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy(" ")).toEqual(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("10.0.0.0/8, 100.64.0.0/10")).toEqual(["10.0.0.0/8", "100.64.0.0/10"]);
    expect(loadConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
  });

  it("生产环境:必须有 JWT 密钥、正式短信和数据库地址", () => {
    const prod = { NODE_ENV: "production", JWT_SECRET: "x".repeat(48), SMS_PROVIDER: "aliyun", DATABASE_URL: "postgres://app:pw@db.internal:5432/yutu" };
    expect(loadConfig(prod).databaseUrl).toBe(prod.DATABASE_URL);
    expect(() => loadConfig({ ...prod, DATABASE_URL: "" })).toThrow("生产环境必须设置 DATABASE_URL");
    expect(() => loadConfig({ ...prod, JWT_SECRET: undefined })).toThrow("JWT_SECRET");
    expect(() => loadConfig({ ...prod, SMS_PROVIDER: undefined })).toThrow("SMS_PROVIDER");
    // 开发环境没有数据库地址时用 PGlite
    expect(loadConfig({}).databaseUrl).toBeNull();
  });

  it("苹果根证书目录、Sign in with Apple 密钥来自环境变量", () => {
    const c = loadConfig({ APPLE_ROOT_CERTS_DIR: "/etc/lingo/apple-roots", APPLE_TEAM_ID: "T", APPLE_SIGNIN_KEY_ID: "K", APPLE_SIGNIN_PRIVATE_KEY: "P" });
    expect(c.apple).toMatchObject({ rootCertsDir: "/etc/lingo/apple-roots", teamId: "T", signInKeyId: "K", signInPrivateKey: "P" });
    expect(loadConfig({}).apple.rootCertsDir).toBeUndefined();
  });
});

describe("PGlite 数据目录", () => {
  it("哪些写法是本机目录", () => {
    expect(pgliteFsDir("./data/pglite")).toBe("./data/pglite");
    expect(pgliteFsDir("file:///var/lib/yutu/pglite")).toBe("/var/lib/yutu/pglite");
    expect(pgliteFsDir("memory://")).toBeNull();
    expect(pgliteFsDir("idb://yutu")).toBeNull();
  });

  it("上级目录不存在时先建好(新检出的仓库直接 npm run dev 也能启动)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yutu-pglite-"));
    const dir = join(root, "nested", "data", "pglite");
    try {
      const db = await createDb(testConfig({ pgliteDir: dir }));
      expect(existsSync(dir)).toBe(true);
      await db.destroy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("trustProxy:决定 req.ip(短信按 IP 限流用的就是它)", () => {
  let t: TestApp;
  const apps: FastifyInstance[] = [];
  let n = 0;
  beforeAll(async () => {
    t = await makeTestApp();
  }, 60_000);
  afterAll(async () => {
    for (const a of apps) await a.close();
    await t?.app.close();
  });

  /** 用这种 TRUST_PROXY 起一个服务器(共用数据库),发一条验证码,看记下的 IP */
  async function ipSeen(trustProxy: string | undefined, remoteAddress: string, forwardedFor?: string) {
    const app = await buildApp({ ...t.deps, config: { ...t.deps.config, trustProxy: parseTrustProxy(trustProxy) } });
    apps.push(app);
    const phone = `1580000${String(++n).padStart(4, "0")}`;
    const r = await app.inject({ method: "POST", url: ROUTES.smsSend, payload: { phone }, remoteAddress, headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {} });
    expect(r.statusCode).toBe(200);
    return (await t.deps.db.selectFrom("sms_codes").select("ip").where("phone", "=", phone).executeTakeFirstOrThrow()).ip;
  }

  it("默认:只信内网来的代理;公网直连时伪造的 X-Forwarded-For 不算", async () => {
    // 阿里云负载均衡(100.64.0.0/10)转发
    expect(await ipSeen(undefined, "100.64.1.1", "203.0.113.5")).toBe("203.0.113.5");
    // 负载均衡 → nginx(本机)→ 服务器;客户端自己在最前面塞了一个假的
    expect(await ipSeen(undefined, "127.0.0.1", "6.6.6.6, 203.0.113.5, 10.0.0.3")).toBe("203.0.113.5");
    // 公网直连
    expect(await ipSeen(undefined, "198.51.100.7", "203.0.113.5")).toBe("198.51.100.7");
  });

  it("TRUST_PROXY=false 不看 X-Forwarded-For;=1 信最近一跳(负载均衡的地址不在内网段时用);网段列表只信列出的", async () => {
    expect(await ipSeen("false", "10.0.0.2", "203.0.113.5")).toBe("10.0.0.2");
    expect(await ipSeen("1", "198.51.100.7", "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
    expect(await ipSeen("10.0.0.0/8", "100.64.0.9", "203.0.113.5")).toBe("100.64.0.9");
    expect(await ipSeen("10.0.0.0/8", "10.1.2.3", "203.0.113.5")).toBe("203.0.113.5");
  });
});
