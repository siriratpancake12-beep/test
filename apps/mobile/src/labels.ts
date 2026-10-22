import { issueName, type IssueKind, type Skill4 } from "@lingo/core";

export const issueLabel = (k: IssueKind) => issueName(k);

export const SKILL_ZH: Record<Skill4, string> = { listen: "听", speak: "说", read: "读", write: "写" };

export const zhMonth = (day: string) => `${day.slice(0, 4)} 年 ${Number(day.slice(5, 7))} 月`;
export const zhDate = (day: string) => `${zhMonth(day)} ${Number(day.slice(8, 10))} 日`;
