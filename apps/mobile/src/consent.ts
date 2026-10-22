import { storage } from "./storage";

/**
 * 隐私同意。国内应用商店和工信部检测的硬性要求:第一次打开先给《用户协议》《隐私政策》摘要,
 * 点"同意"之前不收集任何数据(包括埋点)、不申请任何权限;不同意也不能强制退出或反复弹窗。
 *
 * 同意的版本和时间只存在本机。协议正文改版时,把 CONSENT_VERSION 改成新版的生效日期,
 * 所有人下次打开都会先看到"协议更新了",重新同意后才继续使用。
 */
export const CONSENT_VERSION = "2026-10-23";

const KEY = "consent";

export interface Consent {
  /** 同意的是哪一版协议 */
  version: string;
  /** 什么时候同意的(ISO 时间) */
  at: string;
}

/** 本机记录的同意(任何版本);没同意过或记录损坏都是 null */
export async function readConsent(): Promise<Consent | null> {
  try {
    const raw = await storage.getItem(KEY);
    const c = raw ? (JSON.parse(raw) as Partial<Consent>) : null;
    return c && typeof c.version === "string" && typeof c.at === "string" ? { version: c.version, at: c.at } : null;
  } catch {
    return null;
  }
}

export async function saveConsent(now = new Date()): Promise<Consent> {
  const c: Consent = { version: CONSENT_VERSION, at: now.toISOString() };
  await storage.setItem(KEY, JSON.stringify(c));
  return c;
}

export const clearConsent = () => storage.removeItem(KEY);

/** 同意的是不是现在这一版 */
export const isCurrent = (c: Consent | null) => c?.version === CONSENT_VERSION;
