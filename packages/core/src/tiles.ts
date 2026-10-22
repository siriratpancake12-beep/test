/**
 * 排序题的词块:按空格切,单独的标点并到相邻的词上。
 * 法语的 ? ! : ; 和 » 前面要空格("Ça va ?"),直接按空格切会多出只有一个 "?" 的词块;
 * « 后面也有空格,并到后一个词上。
 */
const CLOSING = /^[?!:;.,…»”)]+$/;
const OPENING = /^[«“(¿¡]+$/;

export function splitTiles(text: string): string[] {
  const out: string[] = [];
  let open = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (OPENING.test(w)) open += `${w} `;
    else if (CLOSING.test(w) && out.length) out[out.length - 1] += ` ${w}`;
    else {
      out.push(open + w);
      open = "";
    }
  }
  if (open && out.length) out[out.length - 1] += ` ${open.trim()}`;
  return out;
}
