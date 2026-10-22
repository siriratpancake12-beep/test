import { z } from "zod";

/**
 * 内容格式(所有语种共用)。
 *
 * 和参考项目最大的不同:字段名与语种无关。学习语言的原文一律叫 `text`,
 * 中文解释一律叫 `zh`;语种特有的信息(德语名词的性、日语读音、韩语罗马字……)
 * 放在 `features` 里,由语言包声明它会用到哪些。
 */

export const LangCode = z.enum(["en", "fr", "de", "es", "ja", "ko", "ru", "it", "pt", "ar"]);
export type LangCode = z.infer<typeof LangCode>;

export const Cefr = z.enum(["pre-A1", "A1", "A2", "B1", "B2", "C1"]);
export type Cefr = z.infer<typeof Cefr>;

export const Skill = z.enum(["listen", "speak", "read", "write"]);

/** 语种特有的词条信息。全部可选,语言包的 `features` 决定哪些必须填(见 validate)。 */
export const ItemFeatures = z.object({
  /** 名词的性:德语 m/f/n,法语、西语、意语 m/f */
  gender: z.enum(["m", "f", "n"]).optional(),
  /** 复数形式(德语名词必须填,复数是学习难点) */
  plural: z.string().optional(),
  /** 读音:日语假名、汉字词的读法 */
  reading: z.string().optional(),
  /** 罗马字/转写:日语、韩语、俄语给初学者看 */
  roman: z.string().optional(),
  /** 国际音标 */
  ipa: z.string().optional(),
  /** 日语高低音核位置(0 = 平板) */
  pitch: z.number().int().min(0).optional(),
  /** 动词变位表的 id(由语言包的变位规则生成练习) */
  conjugation: z.string().optional(),
}).strict();
export type ItemFeatures = z.infer<typeof ItemFeatures>;

/** 学习单位:一个词或一个固定说法。SRS 卡片以它为单位,id 一旦发布永不改。 */
export const Item = z.object({
  id: z.string().regex(/^[a-z]{2}\.[a-z0-9_]+$/, "id 形如 de.hund"),
  kind: z.enum(["word", "phrase"]),
  pos: z.enum(["noun", "propn", "verb", "adj", "adv", "pron", "prep", "conj", "num", "interj", "phrase", "det"]),
  text: z.string().min(1),
  zh: z.string().min(1),
  /** 可接受的其他写法(拼写变体、口语缩写等) */
  alt: z.array(z.string()).optional(),
  features: ItemFeatures.default({}),
  /** 给中国学习者的提示:和中文/英语的对比、常见错误 */
  noteZh: z.string().optional(),
  audio: z.string().optional(),
  image: z.string().optional(),
});
export type Item = z.infer<typeof Item>;

export const Line = z.object({
  speaker: z.string(),
  text: z.string().min(1),
  zh: z.string().min(1),
  /** 这句用到的词条 id,用于"只用学过的词"检查和点词查义 */
  items: z.array(z.string()).default([]),
  audio: z.string().optional(),
});
export type Line = z.infer<typeof Line>;

/** 语法点:用中文讲清楚,配例句。 */
export const GrammarNote = z.object({
  id: z.string(),
  titleZh: z.string(),
  bodyZh: z.string(),
  examples: z.array(z.object({ text: z.string(), zh: z.string() })).min(1),
});
export type GrammarNote = z.infer<typeof GrammarNote>;

export const Lesson = z.object({
  id: z.string().regex(/^[a-z]{2}\.[a-z0-9]+\.[a-z0-9]+$/, "id 形如 de.a1u1.l01"),
  schemaVersion: z.literal(1),
  lang: LangCode,
  /** 引擎按 type 选播放器;新加题型只加播放器,不改引擎 */
  type: z.enum(["dialogue", "vocab", "grammar", "reading", "listening", "roleplay", "test"]),
  cefr: Cefr,
  unit: z.string(),
  order: z.number().int().positive(),
  titleZh: z.string(),
  goalZh: z.string(),
  skills: z.array(Skill).min(1),
  estimatedMinutes: z.number().positive(),
  /** 本课新教的词条 */
  newItems: z.array(Item),
  /** 本课复用的旧词条 id(必须在之前的课里教过) */
  reviewItems: z.array(z.string()).default([]),
  lines: z.array(Line).default([]),
  grammar: z.array(GrammarNote).default([]),
  /** 审校状态:上线前必须是 native(母语者审过) */
  review: z.enum(["draft", "ai", "native"]).default("draft"),
});
export type Lesson = z.infer<typeof Lesson>;

export const LanguagePack = z.object({
  code: LangCode,
  nameZh: z.string(),
  nativeName: z.string(),
  /** 文字:latin 用拉丁字母输入;kana/hangul/cyrillic/arabic 需要专门的键盘与转写 */
  script: z.enum(["latin", "kana", "hangul", "cyrillic", "arabic"]),
  rtl: z.boolean().default(false),
  /** 该语种词条必须/可以带的特性 */
  features: z.object({
    nounGender: z.enum(["none", "mf", "mfn"]).default("none"),
    requirePlural: z.boolean().default(false),
    reading: z.boolean().default(false),
    roman: z.boolean().default(false),
    pitch: z.boolean().default(false),
  }),
  /** 冠词表:用于"选冠词"练习和性别判错 */
  articles: z.record(z.string(), z.string()).optional(),
  /** 语音:识别/合成/发音评测的区域代码 */
  locale: z.string(),
  /** 主流考试,用于考试方向的课程线 */
  examsZh: z.array(z.string()).default([]),
  /** 给中国学习者的总体难点提示 */
  tipsZh: z.array(z.string()).default([]),
});
export type LanguagePack = z.infer<typeof LanguagePack>;
