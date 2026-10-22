import { storage } from "./storage";

/**
 * 隐私同意。国内应用商店和工信部检测的硬性要求:第一次打开先给《用户协议》《隐私政策》摘要,
 * 点"同意"之前不收集任何数据(包括埋点)、不申请任何权限;不同意也不能强制退出或反复弹窗。
 *
 * 不同意时可以选"先用基本功能"(工信部:不得因为不同意处理非必要的个人信息就拒绝提供服务):
 * 离线学习、复习、看周报照常;不记埋点、不联网、不申请权限;登录、同步、AI 对话、发音评测、
 * 开通会员这些要处理个人信息的功能显示"同意隐私政策后可用"。这个选择也记在本机,下次打开不再追问,
 * 随时可以在设置里改成同意。
 *
 * 同意的版本和时间只存在本机。协议正文改版时,把 CONSENT_VERSION 改成新版的生效日期,
 * 所有人下次打开都会先看到"协议更新了",重新同意后才继续使用(也可以改用基本功能)。
 */
export const CONSENT_VERSION = "2026-10-23";

const KEY = "consent";
const KEY_BASIC = "consent:basic";

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

/** 同意现在这一版:同时退出基本功能模式 */
export async function saveConsent(now = new Date()): Promise<Consent> {
  const c: Consent = { version: CONSENT_VERSION, at: now.toISOString() };
  await storage.setItem(KEY, JSON.stringify(c));
  await storage.removeItem(KEY_BASIC);
  return c;
}

/** 不同意,先用基本功能(撤回同意也是这样):同意记录删掉 */
export async function chooseBasic(now = new Date()): Promise<void> {
  await storage.setItem(KEY_BASIC, now.toISOString());
  await storage.removeItem(KEY);
}

/** 本机是否选了基本功能模式 */
export async function readBasic(): Promise<boolean> {
  try {
    return !!(await storage.getItem(KEY_BASIC));
  } catch {
    return false;
  }
}

/** 回到第一次打开的状态(注销账号) */
export async function clearConsent(): Promise<void> {
  await storage.removeItem(KEY);
  await storage.removeItem(KEY_BASIC);
}

/** 同意的是不是现在这一版 */
export const isCurrent = (c: Consent | null) => c?.version === CONSENT_VERSION;
