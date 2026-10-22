import { storage } from "./storage";

/**
 * 学习提醒开关(设置页)。只管学习提醒:会员扣费前的提醒是法规要求,不受这个开关影响。
 * 单独放一个文件:notify.ts 排提醒时要读,store.tsx 要写,两边都引用这里,不互相引用。
 */
export const REMINDERS_KEY = "reminders";

/** 没有记录 = 开(默认) */
export async function remindersEnabled(): Promise<boolean> {
  try {
    return (await storage.getItem(REMINDERS_KEY)) !== "off";
  } catch {
    return true;
  }
}

export const setRemindersEnabled = (on: boolean) => storage.setItem(REMINDERS_KEY, on ? "on" : "off");
