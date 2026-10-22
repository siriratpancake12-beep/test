import Fastify, { type FastifyInstance } from "fastify";
import type { AppStoreVerifier } from "@lingo/billing";
import type { Config } from "./config";
import type { Db } from "./db";
import { frameworkErrors, installErrorHandler } from "./errors";
import { registerAccount } from "./routes/account";
import { registerAdmin } from "./routes/admin";
import { registerAuth, type AppleIdVerifier, type AppleTokenClient, type SmsSender, type WechatClient } from "./routes/auth";
import { registerBilling } from "./routes/billing";
import { registerEvents } from "./routes/events";
import { registerHealth } from "./routes/health";
import { registerSpeech, type SpeechScorer } from "./routes/speech";
import { registerSync } from "./routes/sync";
import { registerTutor, type LlmClient } from "./routes/tutor";

/** 每个接口模块拿到的依赖。外部服务都是接口,测试时换成假的。 */
export interface Deps {
  db: Db;
  config: Config;
  now: () => Date;
  sms: SmsSender;
  apple: AppleIdVerifier | null;
  /** Sign in with Apple 的令牌接口(换刷新令牌、注销时撤销);没配密钥时为 null */
  appleTokens: AppleTokenClient | null;
  wechat: WechatClient | null;
  appStore: AppStoreVerifier | null;
  llm: LlmClient | null;
  speech: SpeechScorer | null;
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.env !== "test",
    bodyLimit: 2 * 1024 * 1024,
    // 决定 req.ip:负载均衡后面要按 X-Forwarded-For 取真实 IP(短信按 IP 限流等),见 config.trustProxy
    trustProxy: trustProxyOption(deps.config.trustProxy),
    // 路由之前的错误(地址格式不对)也用统一的中文错误格式
    frameworkErrors,
  });
  installErrorHandler(app);
  registerHealth(app, deps);
  registerAuth(app, deps);
  registerAccount(app, deps);
  registerSync(app, deps);
  registerEvents(app, deps);
  registerAdmin(app, deps);
  registerBilling(app, deps);
  registerTutor(app, deps);
  registerSpeech(app, deps);
  await app.ready();
  return app;
}

/** 配置里的数字表示"信最近 N 跳代理"(不管代理的地址是什么);Fastify 的类型不收数字,换成等价的判断函数 */
function trustProxyOption(v: Config["trustProxy"]): boolean | string[] | ((address: string, hop: number) => boolean) {
  return typeof v === "number" ? (_address, hop) => hop < v : v;
}
