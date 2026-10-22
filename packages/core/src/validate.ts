import { splitArticle } from "./grading";
import { LanguagePack, Lesson, type Item } from "./schema";

/**
 * 整门课的内容检查。发布前必须 0 个错误。
 * 除了格式,还查教学上的规则:课文只能用学过的词、德语名词冠词和性别一致、id 不重复。
 */
export interface Problem { lesson: string; msg: string }

export function validateCourse(packRaw: unknown, lessonsRaw: unknown[]): Problem[] {
  const problems: Problem[] = [];
  const packParsed = LanguagePack.safeParse(packRaw);
  if (!packParsed.success) return [{ lesson: "-", msg: `语言包格式错误:${packParsed.error.message}` }];
  const pack = packParsed.data;

  const lessons: Lesson[] = [];
  lessonsRaw.forEach((raw, i) => {
    const r = Lesson.safeParse(raw);
    if (r.success) lessons.push(r.data);
    else problems.push({ lesson: (raw as { id?: string })?.id ?? `#${i}`, msg: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
  });

  const seenLesson = new Set<string>();
  const taught = new Map<string, Item>();
  for (const l of [...lessons].sort((a, b) => a.order - b.order)) {
    const P = (msg: string) => problems.push({ lesson: l.id, msg });
    if (seenLesson.has(l.id)) P("课 id 重复");
    seenLesson.add(l.id);
    if (l.lang !== pack.code) P(`lang 是 ${l.lang},语言包是 ${pack.code}`);
    if (!l.id.startsWith(pack.code + ".")) P("课 id 要以语言代码开头");

    for (const it of l.newItems) {
      if (!it.id.startsWith(pack.code + ".")) P(`${it.id}: 词条 id 要以语言代码开头`);
      if (taught.has(it.id)) P(`${it.id}: 已经在前面的课教过,应放进 reviewItems`);
      checkFeatures(it, pack).forEach((m) => P(`${it.id}: ${m}`));
    }
    for (const id of l.reviewItems) if (!taught.has(id)) P(`复习词 ${id} 之前没教过`);
    for (const it of l.newItems) taught.set(it.id, it);
    if (l.lines.length >= 4 && l.questions.length < 2) P("课文 4 句以上的课至少要有 2 道理解题(questions)");
    l.questions.forEach((q, i) => {
      if (q.answer >= q.options.length) P(`理解题 ${i + 1} 的答案序号超出选项范围`);
      if (new Set(q.options).size !== q.options.length) P(`理解题 ${i + 1} 有重复的选项`);
    });
    if (l.type === "reading" && l.lines.length > 0 && l.lines.length < 6) P("短文(reading)至少 6 句");
    for (const line of l.lines) {
      const len = sentenceLength(line.text, pack);
      const max = MAX_SENTENCE[pack.code === "ja" ? "ja" : pack.code === "ko" ? "ko" : "words"][l.cefr];
      if (max !== undefined && len > max) P(`句子太长(${len} > ${max}):"${line.text}"——${l.cefr} 阶段要拆短`);
      for (const id of line.items) if (!taught.has(id)) P(`句子"${line.text}"用到没教过的词 ${id}`);
      if (pack.features.reading && /\p{Script=Han}/u.test(line.text) && !line.reading) P(`句子"${line.text}"有汉字,缺少整句读音 reading`);
      if (line.tokens && line.tokens.join("") !== line.text.replace(/\s+/g, "")) P(`句子"${line.text}"的分词 tokens 连起来和原句不一致`);
      if (pack.cast && line.speaker !== "narrator" && !pack.cast[line.speaker]) P(`说话人 ${line.speaker} 不在语言包的角色表里`);
    }
  }
  return problems;
}

/**
 * 句子长度上限(按等级):有空格的语言按词数,日语按字数(不含标点)。
 * 太长的句子初学者听不过来、跟读不下来,宁可拆成两句。
 */
const MAX_SENTENCE: Record<"words" | "ko" | "ja", Record<string, number>> = {
  words: { "pre-A1": 10, A1: 15, A2: 22, B1: 30, B2: 40, C1: 60 },
  ko: { "pre-A1": 8, A1: 12, A2: 16, B1: 22, B2: 30, C1: 45 },
  ja: { "pre-A1": 20, A1: 30, A2: 45, B1: 60, B2: 80, C1: 120 },
};

export function sentenceLength(text: string, pack: LanguagePack): number {
  if (pack.code === "ja") return [...text.replace(/[\s、。!?!?「」『』()()…・]/g, "")].length;
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** 语种特性检查:德语名词要有性和复数、冠词和性一致;日语要有读音…… */
export function checkFeatures(it: Item, pack: LanguagePack): string[] {
  const out: string[] = [];
  const f = it.features;
  if (it.kind === "char") return pack.features.roman && !f.roman ? ["缺少罗马音 roman"] : [];
  if (it.pos === "noun" && pack.features.nounGender !== "none") {
    if (!f.gender) out.push("名词缺少性别 gender");
    else if (pack.features.nounGender === "mf" && f.gender === "n") out.push("这个语种没有中性");
    // 俄语有性但没有冠词:只要求标 gender
    const sp = splitArticle(it.text, pack);
    if (!sp && pack.articles) out.push(`名词要带冠词写(如 ${Object.keys(pack.articles)[0] ?? ""} ...),方便记性别`);
    else if (sp && f.gender) {
      const g = pack.articles?.[sp[0].toLowerCase()];
      // l' 这种不区分性别的冠词(标为 "mf")不检查
      if (g && g !== "mf" && g !== "pl" && g !== f.gender) out.push(`冠词 ${sp[0]} 和性别 ${f.gender} 不一致`);
    }
    if (pack.features.requirePlural && f.plural === undefined) out.push("缺少复数 plural(没有复数写 \"-\")");
    if (pack.code === "de" && sp && !/^\p{Lu}/u.test(sp[1])) out.push("德语名词首字母要大写");
  }
  if (pack.features.reading && /\p{Script=Han}/u.test(it.text) && !f.reading) out.push("含汉字,缺少读音 reading");
  if (pack.features.roman && !f.roman) out.push("缺少罗马字 roman");
  return out;
}
