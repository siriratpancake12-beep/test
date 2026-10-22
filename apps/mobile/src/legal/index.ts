// 由 apps/mobile/scripts/gen-legal.mts 根据 docs/legal/*.md 生成,不要手改。
// 改协议请改 Markdown,然后在仓库根目录运行:npx tsx apps/mobile/scripts/gen-legal.mts
import type { LegalDoc, LegalKey } from "./types";
import { terms } from "./terms";
import { privacy } from "./privacy";
import { renewal } from "./renewal";
import { minors } from "./minors";
import { sdk } from "./sdk";
import { permissions } from "./permissions";

/** 全部协议,按 /legal?doc=<key> 取 */
export const LEGAL_DOCS: Record<LegalKey, LegalDoc> = { terms, privacy, renewal, minors, sdk, permissions };

/** 协议列表页的顺序 */
export const LEGAL_KEYS: LegalKey[] = ["terms", "privacy", "renewal", "minors", "sdk", "permissions"];

export const isLegalKey = (k: string | undefined): k is LegalKey => !!k && (LEGAL_KEYS as string[]).includes(k);
