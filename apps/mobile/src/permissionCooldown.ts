import { storage } from "./storage";

/**
 * 权限被拒后 48 小时内不再弹系统授权框:《权限使用说明》里这样承诺了,国内商店的隐私合规检测也查这一条
 * (拒绝后再点同一个功能,48 小时内弹出系统授权框就算"频繁索权")。这期间只提示可以去系统设置里打开。
 * 只在本机记下被拒的时间,不上传。iOS 拒绝一次以后系统本来就不再弹;主要管安卓。
 */
export type Permission = "microphone" | "notifications";

export const PERMISSION_COOLDOWN_MS = 48 * 3_600_000;

const key = (p: Permission) => `permission-denied:${p}`;

export async function deniedRecently(p: Permission, now = Date.now()): Promise<boolean> {
  try {
    const at = Number(await storage.getItem(key(p)));
    return at > 0 && now - at < PERMISSION_COOLDOWN_MS;
  } catch {
    return false;
  }
}

export async function noteDenied(p: Permission, now = Date.now()): Promise<void> {
  try {
    await storage.setItem(key(p), String(now));
  } catch {
    // 记不下来就算了:最多是 48 小时内可能再问一次
  }
}
