/**
 * App 内显示的协议文本。正文在 docs/legal/*.md(给律师审、给商店填链接用的是同一份),
 * 由 apps/mobile/scripts/gen-legal.mts 转成这里的 TS 模块,两边不会对不上。
 *
 * 文本里保留两种行内标记,显示时再解析(见 inline.ts):
 * **加粗**(法律要求显著提示的条款),[文字](doc:privacy) 或 [文字](https://…) 链接。
 */
export type LegalKey = "terms" | "privacy" | "renewal" | "minors" | "sdk" | "permissions";

export type LegalBlock =
  | { t: "h2" | "h3" | "p"; text: string }
  /** 引用块:文首的"草稿"提示、更新日期 */
  | { t: "note"; lines: string[] }
  /** 列表项。mark 是"•"或原文的序号(如"1.");level 2 是缩进的子项 */
  | { t: "li"; text: string; mark: string; level: 1 | 2 }
  /** 表格。手机屏幕窄,显示时每行变成一张卡片 */
  | { t: "table"; head: string[]; rows: string[][] };

export interface LegalDoc {
  key: LegalKey;
  /** 文件名,也是页面标题,如"隐私政策" */
  short: string;
  /** 正文第一行的标题,如"语途隐私政策" */
  title: string;
  /** 来源文件,方便对照 */
  source: string;
  blocks: LegalBlock[];
}
