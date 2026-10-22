import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * 后台页面:一个 HTML 文件(原生 JS,不用构建)。数据都从 /v1/admin/metrics 取,页面本身不含数据。
 * 内容安全策略只允许这个页面自带的那段脚本(按哈希),外部脚本和注入的脚本都不会执行。
 */
export const ADMIN_HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(ADMIN_HTML)?.[1] ?? "";

export const ADMIN_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": [
    "default-src 'none'",
    `script-src 'sha256-${createHash("sha256").update(inlineScript, "utf8").digest("base64")}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
