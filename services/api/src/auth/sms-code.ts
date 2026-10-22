import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { atLocal, dayKey } from "@lingo/core";

/**
 * 短信验证码的规则。数字集中放在这里,上线后按 429 的日志调整(比如移动网络大 NAT 出口的 IP 限流是否太紧)。
 */
export const SMS_RULES = {
  /** 有效期 */
  ttlMs: 5 * 60_000,
  /** 一个验证码最多试几次(对的错的都算;试满了要重新获取) */
  maxAttempts: 5,
  /** 同一手机号两次发送的最短间隔 */
  phoneCooldownMs: 60_000,
  /** 同一手机号每天(北京时间的自然日,和短信服务商的日限额口径一致)最多发几条 */
  phonePerDay: 10,
  /** 同一 IP 每小时最多发几条(防止有人拿我们的接口给别人的手机"短信轰炸") */
  ipPerHour: 20,
  /** 发送记录保留多久(限流只需要最近一天;手机号和 IP 是个人信息,不多留) */
  keepMs: 2 * 86_400_000,
} as const;

/** 6 位数字,用密码学随机数(Math.random 可预测) */
export const newSmsCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/**
 * 验证码只存哈希。6 位数字只有一百万种,普通哈希一枚举就破;用服务器密钥做 HMAC,
 * 只拿到数据库的人算不出验证码。把手机号也算进去,同一个码在不同手机号上的哈希不同。
 */
export function hashSmsCode(secret: string, phone: string, code: string): string {
  const k = createHmac("sha256", secret).update("sms-code-v1").digest();
  return createHmac("sha256", k).update(`${phone}:${code}`).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 北京时间当天 0 点(每天的发送次数从这里算起) */
export const beijingDayStart = (now: Date): Date => atLocal(dayKey(now, 480), 0, 0, 480);
