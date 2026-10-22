import { applySubEvent, type SubEvent, type Subscription } from "@lingo/core";
import { isStale } from "./types";

/**
 * 把同一条商店数据(一笔交易或一条通知)产生的事件应用到会员状态,过时的(见 isStale)跳过。
 * 调用方先按事件 id 去重,只传第一次见到的事件。
 */
export function applyStoreEvents(sub: Subscription | null, events: SubEvent[], periodEnd: Date | undefined, now: Date): Subscription | null {
  return events.reduce<Subscription | null>((s, ev) => (isStale(s, periodEnd, now) ? s : applySubEvent(s, ev)), sub);
}
