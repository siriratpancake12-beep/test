/**
 * 命令行跑定时任务(不等服务器里的定时器;也可以交给系统 cron 或云上的定时任务):
 *   npm run purge -w @lingo/api          按保存期限清理一次
 *   npm run renewal-sms -w @lingo/api    发一轮扣费前短信(只在北京时间 8–21 点发)
 * 读和服务器一样的环境变量(数据库、短信)。结果(条数,没有个人信息)打印出来,也记进 job_runs(时段写 cli:<时间>,
 * 不占定时器的时段)。和服务器的定时器同时跑也没关系:清理可以重复执行,短信每个账号每一期只发一条。
 * 开发时用的 PGlite 同一时间只能被一个进程打开:先停掉 npm run dev 再跑。
 */
import { loadConfig } from "../config";
import { createDb } from "../db";
import { createSmsNotifier } from "../routes/auth";
import { runJob, type Job, type JobLog } from "./index";
import { sendRenewalReminders } from "./renewal-sms";
import { purgeExpired } from "./retention";

const log: JobLog = {
  info: (obj, msg) => console.log(msg, JSON.stringify(obj)),
  warn: (obj, msg) => console.warn(msg, JSON.stringify(obj)),
  error: (obj, msg) => console.error(msg, obj),
};

const task = process.argv[2];
const config = loadConfig();
const jobs: Record<string, (db: Awaited<ReturnType<typeof createDb>>) => Job> = {
  purge: (db) => ({ name: "purge", slot: () => null, run: (now) => purgeExpired(db, now) }),
  "renewal-sms": (db) => ({
    name: "renewal-sms",
    slot: () => null,
    run: (now) => sendRenewalReminders({ db, now, notifier: createSmsNotifier(config), templateCode: config.sms.renewalTemplateCode, log }),
  }),
};

const make = task ? jobs[task] : undefined;
if (!make) {
  console.error("用法:npm run purge -w @lingo/api,或者 npm run renewal-sms -w @lingo/api");
  process.exitCode = 2;
} else {
  const db = await createDb(config);
  try {
    const now = () => new Date();
    const r = await runJob(db, make(db), now, log, `cli:${now().toISOString()}`);
    if (!r.ok) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
