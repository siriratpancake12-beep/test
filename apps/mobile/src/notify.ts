import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { renewalReminder, studyReminders, type Progress, type Subscription } from "@lingo/core";

/**
 * 本地通知:学习提醒(学习者习惯的时间、只排 3 天)和扣费前提醒(前 5 天、前 1 天)。
 * 权限不在第一次打开时要,而是学完第一课、尝到甜头之后再问,同意率高得多。
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

/** 还没问过才返回 true(问过被拒的,系统不允许再弹) */
export async function canAskNotifications(): Promise<boolean> {
  const st = await Notifications.getPermissionsAsync();
  return !st.granted && st.canAskAgain;
}

export async function askNotifications(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: "学习提醒", importance: Notifications.AndroidImportance.DEFAULT });
  }
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** 重新排所有提醒(打开首页时调用)。没有通知权限就什么也不做。 */
export async function reschedule(p: Progress, sub: Subscription | null, title: string, now = new Date()) {
  if (!(await notificationsGranted())) return;
  await Notifications.cancelAllScheduledNotificationsAsync();
  const jobs: { at: Date; body: string; title: string }[] = studyReminders(p, now).map((r) => ({ ...r, title }));
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
