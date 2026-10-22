import type { Progress, Subscription } from "@lingo/core";

/** 网页预览没有本地通知,全部空实现(接口和 notify.ts 一致)。 */
export const notificationsGranted = async () => false;
export const canAskNotifications = async () => false;
export const askNotifications = async () => false;
export async function cancelAllReminders(): Promise<void> {}
export async function reschedule(_p: Progress, _sub: Subscription | null, _title: string, _now = new Date()) {}
