import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { createJobs, startJobs } from "./jobs";
import { createAuthProviders, createSmsNotifier } from "./routes/auth";
import { createAppStoreVerifier } from "./routes/billing";
import { createSpeechScorer } from "./routes/speech";
import { createLlmClient } from "./routes/tutor";

const config = loadConfig();
const db = await createDb(config);
const now = () => new Date();
const app = await buildApp({
  db,
  config,
  now,
  ...createAuthProviders(config),
  appStore: createAppStoreVerifier(config),
  llm: createLlmClient(config),
  speech: createSpeechScorer(config),
});
await app.listen({ port: config.port, host: "0.0.0.0" });

// 日志里不写审核手机号和验证码
if (config.review) app.log.info("审核账号已开启(REVIEW_PHONE):这个手机号不发短信,用固定验证码登录");

// 按保存期限清理、扣费前短信提醒(见 jobs/index.ts)
if (config.jobs.enabled) {
  startJobs({ db, now, log: app.log, jobs: createJobs({ config, db, notifier: createSmsNotifier(config), log: app.log }) });
} else {
  app.log.warn("定时任务已关闭(JOBS_ENABLED=false):保存期限的清理和扣费前短信要用 npm run purge、npm run renewal-sms 另外定时跑");
}
