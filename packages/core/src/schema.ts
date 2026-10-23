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
  /** 名词的性:德语 m/f/n,法语、西语、意语 m/f;pl = 只有复数形式的名词(die Eltern、les gens) */
  gender: z.enum(["m", "f", "n", "pl"]).optional(),
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
  /** char = 字母/假名/谚文(日语、韩语入门先学文字) */
  kind: z.enum(["word", "phrase", "char"]),
  pos: z.enum(["noun", "propn", "verb", "adj", "adv", "pron", "prep", "conj", "num", "interj", "phrase", "det", "particle", "char"]),
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
  /** 整句的假名读音(日语:句子里有汉字时必须填) */
  reading: z.string().optional(),
  /** 罗马音(日语、韩语入门阶段给学习者看) */
  roman: z.string().optional(),
  /**
   * 分词(日语这类不用空格分词的语言):用于"把词排成句子"练习,连起来必须等于原句(不含空格)。
   * 有空格的语言不用填。
   */
  tokens: z.array(z.string().min(1)).optional(),
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

/**
 * 理解题:听完/读完课文后检查听懂了没有。A1 题干用中文,A2 起可以用学习语言(promptZh 给中文意思)。
 */
export const Question = z.object({
  prompt: z.string().min(1),
  promptZh: z.string().optional(),
  options: z.array(z.string().min(1)).min(2).max(4),
  answer: z.number().int().min(0),
  /** 答错时的中文解释(指出课文里哪一句) */
  explainZh: z.string().optional(),
});
export type Question = z.infer<typeof Question>;

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
  /** 学完能做到什么(面向学习者的"能力清单",周报里展示,让进步看得见) */
  canDoZh: z.string().min(1),
  skills: z.array(Skill).min(1),
  estimatedMinutes: z.number().positive(),
  /** 本课新教的词条 */
  newItems: z.array(Item),
  /** 本课复用的旧词条 id(必须在之前的课里教过) */
  reviewItems: z.array(z.string()).default([]),
  lines: z.array(Line).default([]),
  /** 理解题(课文 4 句以上的课至少 2 道) */
  questions: z.array(Question).default([]),
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
  /**
   * 达到各等级大约需要的累计学时(用于给学习者预估"什么时候能到 B1")。
   * 不填用默认值(goal.ts);上线后用真实学习数据校准。
   */
  hoursToLevel: z.object({ "pre-A1": z.number(), A1: z.number(), A2: z.number(), B1: z.number(), B2: z.number(), C1: z.number() }).partial().optional(),
  /**
   * 固定角色表:说话人 id → 名字和性别。整门课用同一组人物,形成连续的故事线;
   * 课文里的 speaker 必须出自这里(或 narrator 旁白)。App 按性别选朗读声音。
   */
  cast: z.record(z.string(), z.object({ name: z.string(), nameZh: z.string(), gender: z.enum(["f", "m"]), bioZh: z.string().optional() })).optional(),
  /** 主角(学习者代入的人)的 cast id;不写就是 cast 里的第一个。"开口说"优先挑主角的句子 */
  protagonist: z.string().optional(),
  /** 主流考试,用于考试方向的课程线 */
  examsZh: z.array(z.string()).default([]),
  /** 给中国学习者的总体难点提示 */
  tipsZh: z.array(z.string()).default([]),
});
export type LanguagePack = z.infer<typeof LanguagePack>;
