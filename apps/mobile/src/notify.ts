import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { renewalReminder, studyReminders, type Progress, type Subscription } from "@lingo/core";
import { deniedRecently, noteDenied } from "./permissionCooldown";
import { personalInfoAllowed } from "./privacy";
import { remindersEnabled } from "./reminders";

/**
 * 本地通知:学习提醒(学习者习惯的时间、只排 3 天)和扣费前提醒(前 5 天、前 1 天)。
 * 权限不在第一次打开时要,而是学完第一课、尝到甜头之后再问,同意率高得多。
 * 没同意隐私政策(基本功能模式)时不申请通知权限,也不排提醒。
 * 学习提醒可以在设置里关掉(reminders.ts);扣费提醒是法规要求,只要开着自动续费就照排。
 *
 * 国内安卓手机后台限制多,本地定时通知可能被系统清掉;正式版要接厂商推送通道
 * (华为、小米、OPPO、vivo、荣耀),由服务器按同样的规则发送。
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

const CHANNEL = "study";

export async function notificationsGranted(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

/** 还没问过才返回 true(问过被拒的,系统不允许再弹;安卓允许再弹的,48 小时内也不问);没同意隐私政策时一律不问 */
export async function canAskNotifications(): Promise<boolean> {
  if (!personalInfoAllowed()) return false;
  const st = await Notifications.getPermissionsAsync();
  return !st.granted && st.canAskAgain && !(await deniedRecently("notifications"));
}

export async function askNotifications(): Promise<boolean> {
  if (!personalInfoAllowed()) return false;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: "学习提醒", importance: Notifications.AndroidImportance.DEFAULT });
  }
  const granted = (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) await noteDenied("notifications");
  return granted;
}

/** 取消全部已经排好的提醒(关掉学习提醒、撤回同意、注销账号时)。没有权限、没有排过也不会出错 */
export async function cancelAllReminders(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync().catch((e: unknown) => console.warn("取消提醒失败", e));
}

/** 重新排所有提醒(打开首页、改了提醒开关时调用)。没有通知权限就什么也不做。 */
export async function reschedule(p: Progress, sub: Subscription | null, title: string, now = new Date()) {
  if (!personalInfoAllowed()) return cancelAllReminders();
  if (!(await notificationsGranted())) return;
  await Notifications.cancelAllScheduledNotificationsAsync();
  const study = (await remindersEnabled()) ? studyReminders(p, now) : [];
  const jobs: { at: Date; body: string; title: string }[] = study.map((r) => ({ ...r, title }));
  if (sub?.autoRenew && (sub.status === "trial" || sub.status === "active")) {
    for (const daysBefore of [5, 1]) {
      const at = new Date(Date.parse(sub.periodEnd) - daysBefore * 86_400_000 + 60_000);
      const r = at > now ? renewalReminder(sub, at) : null;
      if (r) jobs.push({ at, body: r.zh, title: "会员续费提醒" });
    }
  }
  for (const j of jobs) {
    await Notifications.scheduleNotificationAsync({
      content: { title: j.title, body: j.body },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: j.at, ...(Platform.OS === "android" ? { channelId: CHANNEL } : {}) },
    });
  }
}
