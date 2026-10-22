import type { EventName } from "@lingo/core";

/**
 * 埋点。各页面直接调用 track(名字, 属性);事件名和属性见 packages/core/src/events.ts。
 * 负责人:app-account(排队、上传、用户同意前不记录)。这里先是空实现,接口不要改。
 */
export function track(_name: EventName, _props: Record<string, string | number | boolean | null> = {}): void {}
