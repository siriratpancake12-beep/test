import Fastify, { type FastifyInstance } from "fastify";
import type { AppStoreVerifier } from "@lingo/billing";
import type { Config } from "./config";
import type { Db } from "./db";
import { installErrorHandler } from "./errors";
import { registerAccount } from "./routes/account";
import { registerAdmin } from "./routes/admin";
import { registerAuth, type AppleIdVerifier, type SmsSender, type WechatClient } from "./routes/auth";
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
  wechat: WechatClient | null;
  appStore: AppStoreVerifier | null;
  llm: LlmClient | null;
  speech: SpeechScorer | null;
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.config.env !== "test", bodyLimit: 2 * 1024 * 1024 });
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
