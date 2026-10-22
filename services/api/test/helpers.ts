import type { FastifyInstance } from "fastify";
import { buildApp, type Deps } from "../src/app";
import { testConfig } from "../src/config";
import { createDb } from "../src/db";

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
    db: await createDb(config),
    config,
    now: () => now,
    sms: { async send(phone, code) { sentCodes.set(phone, code); } },
    apple: null,
    wechat: null,
    appStore: null,
    llm: null,
    speech: null,
    ...over,
  };
  const app = await buildApp(deps);
  return { app, deps, sentCodes, setNow: (d) => (now = d) };
}
