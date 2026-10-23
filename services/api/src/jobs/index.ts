import type { Config } from "../config";
import type { Db } from "../db";
import { utcDay } from "../db/ai";
import { claimJobSlot, finishJobSlot } from "../db/jobs";
import type { SmsNotifier } from "../routes/auth";
import { sendRenewalReminders, smsHours } from "./renewal-sms";
import { purgeExpired } from "./retention";

/**
 * 定时任务:按保存期限清理数据(purge,每天一次)、扣费前短信提醒(renewal-sms,白天每小时一次)。
 *
 * 服务器里有定时器(startJobs,JOBS_ENABLED=false 可以关),也可以用命令行跑(jobs/cli.ts:npm run purge / renewal-sms)。
 * 上线后至少两台服务器,每台都有定时器:每个任务每个时段先在 job_runs 里占位(主键冲突就是别人占了),谁占到谁跑,
 * 所以同一时段只跑一次。跑的时候出错只记日志和 job_runs(ok = false),不影响接口;这一时段不再重试,
 * 下一个时段接着做(清理是累积的,短信看的是"这一期发没发过")。
 */
export interface JobLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface Job {
  name: string;
  /** 这一刻属于哪个时段(同一时段只跑一次);null 表示现在不跑 */
  slot(now: Date): string | null;
  run(now: Date): Promise<unknown>;
}

const HOUR = 3_600_000;

/** 清理:每天一次。"一天"从北京时间凌晨 3 点(UTC 19 点)算起,用的人最少的时候跑 */
export const purgeSlot = (now: Date): string => utcDay(new Date(now.getTime() - 19 * HOUR));

/** 扣费前短信:北京时间白天每小时一次,夜里不跑 */
export const renewalSmsSlot = (now: Date): string | null => (smsHours(now) ? now.toISOString().slice(0, 13) : null);

export function createJobs(opts: { config: Config; db: Db; notifier: SmsNotifier; log: JobLog }): Job[] {
  const { config, db, notifier, log } = opts;
  const jobs: Job[] = [{ name: "purge", slot: purgeSlot, run: (now) => purgeExpired(db, now) }];
  const templateCode = config.sms.renewalTemplateCode;
  if (templateCode) {
    jobs.push({ name: "renewal-sms", slot: renewalSmsSlot, run: (now) => sendRenewalReminders({ db, now, notifier, templateCode, log }) });
  } else {
    log.warn({}, "没有配置扣费提醒短信模板(SMS_RENEWAL_TEMPLATE_CODE):不发扣费前短信,只有 App 内的提醒");
  }
  return jobs;
}

/**
 * 跑一次任务:先占这个时段,占到了才跑。slot 可以由调用方指定(命令行手动跑用 cli:<时间>,不和定时器抢)。
 * 返回 ran = false 表示这个时段别人跑过了(或者现在不该跑)。
 */
export async function runJob(db: Db, job: Job, now: () => Date, log: JobLog, slot = job.slot(now())): Promise<{ ran: boolean; ok?: boolean; result?: unknown }> {
  if (!slot) return { ran: false };
  if (!(await claimJobSlot(db, job.name, slot, now()))) return { ran: false };
  try {
    const result = await job.run(now());
    await finishJobSlot(db, job.name, slot, now(), true, result);
    log.info({ job: job.name, slot, result }, "定时任务完成");
    return { ran: true, ok: true, result };
  } catch (err) {
    log.error({ err, job: job.name, slot }, "定时任务失败");
    await finishJobSlot(db, job.name, slot, now(), false, { error: err instanceof Error ? err.message : String(err) })
      .catch((e: unknown) => log.error({ err: e, job: job.name }, "记录定时任务结果失败"));
    return { ran: true, ok: false };
  }
}

/**
 * 服务器里的定时器:启动后过一会儿(firstDelayMs)先跑一轮,之后每 everyMs 看一次各任务是否到了新的时段。
 * 一个任务跑完才看下一个,同一台服务器上不会同时跑两个。返回停止函数。
 */
export function startJobs(opts: { db: Db; jobs: Job[]; now: () => Date; log: JobLog; everyMs?: number; firstDelayMs?: number }): () => void {
  const { db, jobs, now, log } = opts;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    // 定时器不拦着进程退出
    timer.unref?.();
  };
  const tick = async () => {
    for (const job of jobs) {
      if (stopped) return;
      await runJob(db, job, now, log).catch((err: unknown) => log.error({ err, job: job.name }, "定时任务失败"));
    }
    schedule(opts.everyMs ?? 10 * 60_000);
  };
  schedule(opts.firstDelayMs ?? 60_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
