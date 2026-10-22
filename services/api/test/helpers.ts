import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { Kysely, PostgresDialect } from "kysely";
import { buildApp, type Deps } from "../src/app";
import { signSession } from "../src/auth/session";
import { testConfig } from "../src/config";
import { migrate, type Database, type Db } from "../src/db";
import { pglitePool } from "../src/db/pglite";

/**
 * 测试用的服务器:内存里的 PGlite 数据库,假的外部服务。
 * 各模块在自己的测试文件里传入需要的假服务(over),不要改这个文件来塞模块专用的东西。
 */
export interface TestApp {
  app: FastifyInstance;
  deps: Deps;
  /** 假短信:手机号 → 最近一次发出的验证码 */
  sentCodes: Map<string, string>;
  /** 把时钟拨到指定时间 */
  setNow: (d: Date) => void;
}

export async function makeTestApp(over: Partial<Deps> = {}): Promise<TestApp> {
  const sentCodes = new Map<string, string>();
  let now = new Date("2026-11-01T12:00:00Z");
  const config = testConfig({ adminToken: "test-admin", ...over.config });
  const deps: Deps = {
    // 传了 db 就共用那个(同一个数据库上起两个配置不同的服务器)
    db: over.db ?? (await createTestDb()),
    config,
    now: () => now,
    sms: { async send(phone, code) { sentCodes.set(phone, code); } },
    apple: null,
    appleTokens: null,
    wechat: null,
    appStore: null,
    llm: null,
    speech: null,
    ...over,
  };
  const app = await buildApp(deps);
  return { app, deps, sentCodes, setNow: (d) => (now = d) };
}

/**
 * 一个全新的、建好表的内存数据库(和 createDb 用 PGlite 时一样)。
 *
 * 为什么不直接 createDb:PGlite 每新建一个库都要跑一遍 initdb(2 秒以上,很吃 CPU),
 * 好几个测试文件并行时互相拖慢,容易超时。所以把"刚 initdb 完的空库"存一份快照
 * (系统临时目录,按 PGlite 版本区分),之后都从快照恢复(约 0.4 秒),再建表。
 */
export async function createTestDb(): Promise<Db> {
  let pg: PGlite;
  try {
    pg = await PGlite.create("memory://", { loadDataDir: await pristineDataDir() });
  } catch {
    // 快照坏了:删掉(下一个库重新生成),这次老老实实 initdb
    pristine = undefined;
    await rm(await snapshotFile(), { force: true });
    pg = await PGlite.create("memory://");
  }
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: pglitePool(pg) }) });
  await migrate(db);
  return db;
}

let pristine: Promise<Blob> | undefined;
/** 刚 initdb 完的数据目录(tar):同一个进程里只做一次;别的测试进程、下次运行直接读文件 */
function pristineDataDir(): Promise<Blob> {
  pristine ??= (async () => {
    const file = await snapshotFile();
    try {
      return new Blob([await readFile(file)]);
    } catch {
      // 还没有快照
    }
    const pg = await PGlite.create("memory://");
    const dump = await pg.dumpDataDir("none");
    await pg.close();
    // 先写临时文件再改名:几个测试进程同时写,也不会有人读到写了一半的文件
    const tmp = `${file}.${process.pid}.${randomUUID()}`;
    await writeFile(tmp, Buffer.from(await dump.arrayBuffer()));
    await rename(tmp, file).catch(() => rm(tmp, { force: true }));
    return dump;
  })();
  return pristine;
}

async function snapshotFile(): Promise<string> {
  const pkgDir = dirname(dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite")));
  const { version } = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as { version: string };
  return join(tmpdir(), `lingo-test-pglite-${version}.tar`);
}

/**
 * 直接建一个用户并签发登录凭证(不走短信,不受短信限流影响)。需要"已登录用户"的测试用:
 * `const u = await createUser(t); t.app.inject({ ..., headers: u.headers })`
 */
export async function createUser(t: TestApp, over: { phone?: string; createdAt?: Date } = {}): Promise<{ userId: string; token: string; headers: { authorization: string } }> {
  const userId = randomUUID();
  await t.deps.db
    .insertInto("users")
    .values({ id: userId, phone: over.phone ?? null, apple_sub: null, wechat_unionid: null, wechat_openid: null, created_at: over.createdAt ?? t.deps.now(), deleted_at: null })
    .execute();
  const token = await signSession(userId, t.deps.config);
  return { userId, token, headers: { authorization: `Bearer ${token}` } };
}
