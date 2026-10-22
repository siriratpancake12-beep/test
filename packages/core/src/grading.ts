import type { Item, LanguagePack } from "./schema";

/**
 * 判断输入的答案。不只是"对/错",还要告诉学习者错在哪,
 * 这样德语的冠词、法语的重音符号这些中国学习者的高频错误才能被针对性地练。
 *
 * - correct:完全正确(忽略大小写以外的标点、多余空格)
 * - almost :意思对了,但有小问题(漏了重音符号、德语名词没大写、一个字母的笔误),算对但提示
 * - wrong  :错了;如果是冠词/性别错了,issues 里会说明
 */
export type Verdict = "correct" | "almost" | "wrong";
export type Issue =
  | { kind: "accent" }
  | { kind: "case" }
  | { kind: "typo" }
  | { kind: "umlaut-fallback" }
  | { kind: "article"; expected: string; got: string }
  | { kind: "reading" };

export interface GradeResult {
  verdict: Verdict;
  issues: Issue[];
  /** 应该显示给学习者的标准答案 */
  expected: string;
}

const PUNCT = /[.,!?¿¡;:"«»“”„‟()…。、!?]/g;

export function normalizeSpace(s: string): string {
  return s
    // NFKC:全角/半角统一(日文、韩文输入法常打出全角字母、数字和标点)
    .normalize("NFKC")
    .replace(/[’‘`´]/g, "'")
    .replace(PUNCT, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 去掉拉丁字母上的变音符号(é→e、ü→u、ñ→n)。只用于拉丁文字,假名的浊音点不能这样去。 */
export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").replace(/ß/g, "ss");
}

/** 德语键盘不方便时常用 ae/oe/ue/ss 代替 ä/ö/ü/ß。 */
export function germanFallback(s: string): string {
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** 把 "der Hund" 拆成 ["der", "Hund"];法语 "l'ami" 拆成 ["l'", "ami"]。不是冠词开头返回 null。 */
export function splitArticle(s: string, pack: LanguagePack): [string, string] | null {
  if (!pack.articles) return null;
  const arts = Object.keys(pack.articles).sort((a, b) => b.length - a.length);
  const lower = s.toLowerCase();
  for (const a of arts) {
    if (a.endsWith("'")) {
      if (lower.startsWith(a)) return [s.slice(0, a.length), s.slice(a.length)];
    } else if (lower.startsWith(a + " ")) {
      return [s.slice(0, a.length), s.slice(a.length + 1)];
    }
  }
  return null;
}

/** 只比较一个候选答案。 */
function gradeOne(input: string, expected: string, pack: LanguagePack): GradeResult {
  const inp = normalizeSpace(input);
  const exp = normalizeSpace(expected);
  const ok = (issues: Issue[] = []): GradeResult => ({ verdict: issues.length ? "almost" : "correct", issues, expected });
  const latin = pack.script === "latin";
  // 只有德语名词首字母大写有意义;其他语种不计较大小写
  const caseMatters = pack.code === "de";

  if (inp === exp) return ok();
  if (inp.toLowerCase() === exp.toLowerCase()) return ok(caseMatters ? [{ kind: "case" }] : []);
  if (!inp) return { verdict: "wrong", issues: [], expected };

  // 冠词/性别错误:后半部分对、冠词不对 → 判错,并指出正确冠词
  const ea = splitArticle(exp, pack);
  const ia = splitArticle(inp, pack);
  if (ea && ia && ea[0].toLowerCase() !== ia[0].toLowerCase()) {
    const restSame = latin
      ? stripAccents(ea[1]).toLowerCase() === stripAccents(ia[1]).toLowerCase()
      : ea[1] === ia[1];
    if (restSame) return { verdict: "wrong", issues: [{ kind: "article", expected: ea[0], got: ia[0] }], expected };
  }

  if (latin) {
    const issues: Issue[] = [];
    if (pack.code === "de" && germanFallback(exp).toLowerCase() === inp.toLowerCase()) {
      issues.push({ kind: "umlaut-fallback" });
      if (caseMatters && germanFallback(exp) !== inp) issues.push({ kind: "case" });
      return ok(issues);
    }
    const ia2 = stripAccents(inp), ea2 = stripAccents(exp);
    if (ia2 === ea2) return ok([{ kind: "accent" }]);
    if (ia2.toLowerCase() === ea2.toLowerCase()) return ok(caseMatters ? [{ kind: "accent" }, { kind: "case" }] : [{ kind: "accent" }]);
    // 一个字母的笔误:只对足够长的词宽容,避免 "Hund"/"Hand" 这种不同的词被放过
    if (ea2.length >= 6 && levenshtein(ia2.toLowerCase(), ea2.toLowerCase()) === 1) return ok([{ kind: "typo" }]);
  }
  return { verdict: "wrong", issues: [], expected };
}

const RANK: Record<Verdict, number> = { correct: 2, almost: 1, wrong: 0 };

/** 按词条判断:标准写法、可接受的变体、(日语)假名读音都算。 */
export function gradeItem(input: string, item: Item, pack: LanguagePack): GradeResult {
  const candidates = [item.text, ...(item.alt ?? [])];
  let best = gradeOne(input, item.text, pack);
  for (const c of candidates.slice(1)) {
    const r = gradeOne(input, c, pack);
    if (RANK[r.verdict] > RANK[best.verdict]) best = { ...r, expected: item.text };
  }
  if (best.verdict !== "correct" && item.features.reading && normalizeSpace(input) === normalizeSpace(item.features.reading)) {
    // 用假名写出了汉字词:算对,提示汉字写法
    return { verdict: "almost", issues: [{ kind: "reading" }], expected: item.text };
  }
  return best;
}

export function gradeText(input: string, expected: string, pack: LanguagePack): GradeResult {
  return gradeOne(input, expected, pack);
}

/** 把问题说成中文提示。 */
export function issueZh(issue: Issue): string {
  switch (issue.kind) {
    case "accent": return "注意重音/变音符号";
    case "case": return "德语名词首字母要大写";
    case "typo": return "有个字母拼错了";
    case "umlaut-fallback": return "可以用 ä ö ü ß,ae/oe/ue/ss 只是替代写法";
    case "article": return `冠词应该是 ${issue.expected},不是 ${issue.got}`;
    case "reading": return "读音对了,试试用汉字写";
  }
}
