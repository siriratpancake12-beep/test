/**
 * 协议文本的行内标记:**加粗**、[文字](链接)、裸露的 https 网址。
 * 生成脚本已经检查过加粗成对、链接有效,这里只负责拆成一段一段给 <Text> 显示。
 */
export interface Span {
  text: string;
  bold?: boolean;
  /** "doc:privacy" 跳到另一份协议;"https://…" 用系统浏览器打开 */
  link?: string;
}

const TOKEN = /\*\*|\[([^\]]+)\]\(([^)\s]+)\)|https?:\/\/[A-Za-z0-9._~:/?#@!$&'+,;=%-]+/g;

export function parseInline(src: string): Span[] {
  const out: Span[] = [];
  let bold = false;
  let last = 0;
  const push = (text: string, link?: string) => {
    if (!text) return;
    out.push({ text, ...(bold ? { bold } : {}), ...(link ? { link } : {}) });
  };
  for (const m of src.matchAll(TOKEN)) {
    push(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0] === "**") bold = !bold;
    else if (m[1] !== undefined) push(m[1], m[2]);
    else {
      // 网址后面紧跟的英文句点、逗号不算网址的一部分
      const url = m[0].replace(/[.,;:!?]+$/, "");
      push(url, url);
      last -= m[0].length - url.length;
    }
  }
  push(src.slice(last));
  return out;
}
