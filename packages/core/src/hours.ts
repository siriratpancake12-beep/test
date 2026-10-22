import type { Cefr, Lesson } from "./schema";
import { splitTiles } from "./tiles";

/**
 * 课程时长和顺序。
 *
 * **学习时长按课的实际内容算,不用手填的数字**:每一步(听课文、理解题、生词、语法、练习、跟读、角色扮演)
 * 按句数、词数、题数乘以每项的平均用时。这样"每门语言 200 小时"是算出来的,可以核对。
 * 每项用时是保守估计;上线后用真实学习数据校准。
 */
export const MINUTES = {
  /** 听/看课文一句(含点开翻译、重听) */
  listenLine: 0.25,
  /** 读短文一句(读物句子更长) */
  readLine: 0.3,
  question: 0.5,
  /** 学一个生词(听、看例子和提示) */
  item: 0.5,
  grammarNote: 2,
  grammarExample: 0.25,
  /** 一道练习题(选择题快、写和说慢,平均) */
  exercise: 0.35,
  /** 跟读一句:听 → 录 → 回放对比 */
  shadowLine: 0.4,
  /** 角色扮演:对方说一句、自己说一句 */
  roleplayLine: 0.3,
} as const;

/** 学过的词之后的间隔复习,按课程时间的 15% 算(保守) */
export const REVIEW_SHARE = 0.15;
/**
 * 每个单元的单元练习(约 25 题)和单元测评(约 15 题),按每题平均用时算,约 14 分钟。
 * 题数见 checkpoint.ts。
 */
export const UNIT_EXTRA_MIN = Math.round((25 + 15) * 0.35);
/** 读物里精选跟读的句数 */
const READER_SHADOW_LINES = 5;

const reorderable = (line: Lesson["lines"][number]) => {
  const n = line.tokens?.length ?? splitTiles(line.text).length;
  return n >= 3 && n <= 10;
};

/** 课后练习的题数(和 exercises.ts 的 lessonPractice 出题规则一致) */
export function practiceCount(l: Lesson): number {
  const reorder = Math.min(2, l.lines.filter(reorderable).length);
  const speak = l.lines.some((x) => x.text.length <= 60) ? 1 : 0;
  return l.newItems.length * 2 + Math.min(3, l.reviewItems.length) + reorder + speak;
}

/** 一节课的学习时长(分钟),按课的类型走不同的流程 */
export function estimateLessonMinutes(l: Lesson): number {
  const lines = l.lines.length;
  const speakers = new Set(l.lines.map((x) => x.speaker)).size;
  let m = l.questions.length * MINUTES.question
    + l.newItems.length * MINUTES.item
    + l.grammar.reduce((a, g) => a + MINUTES.grammarNote + g.examples.length * MINUTES.grammarExample, 0)
    + practiceCount(l) * MINUTES.exercise;
  if (l.type === "reading") {
    m += lines * MINUTES.readLine + Math.min(lines, READER_SHADOW_LINES) * MINUTES.shadowLine;
  } else {
    m += lines * MINUTES.listenLine + lines * MINUTES.shadowLine;
    if (l.type === "dialogue" && speakers >= 2) m += lines * MINUTES.roleplayLine;
  }
  return Math.round(m * 2) / 2;
}

export interface CourseHours {
  totalHours: number;
  byLevel: Partial<Record<Cefr, number>>;
  lessons: number;
  readers: number;
  units: number;
}

/** 整门课的学习时长:课 ×(1 + 复习)+ 每单元的练习和测评 */
export function courseHours(lessons: Lesson[]): CourseHours {
  const byLevel: Partial<Record<Cefr, number>> = {};
  const units = new Map<string, Cefr>();
  for (const l of lessons) {
    const h = (estimateLessonMinutes(l) * (1 + REVIEW_SHARE)) / 60;
    byLevel[l.cefr] = (byLevel[l.cefr] ?? 0) + h;
    units.set(l.unit, l.cefr);
  }
  for (const cefr of units.values()) byLevel[cefr] = (byLevel[cefr] ?? 0) + UNIT_EXTRA_MIN / 60;
  const round = (x: number) => Math.round(x * 10) / 10;
  for (const k of Object.keys(byLevel) as Cefr[]) byLevel[k] = round(byLevel[k]!);
  return {
    totalHours: round(Object.values(byLevel).reduce((a, b) => a + b, 0)),
    byLevel,
    lessons: lessons.filter((l) => l.type !== "reading").length,
    readers: lessons.filter((l) => l.type === "reading").length,
    units: units.size,
  };
}

const LEVEL_INDEX: Record<string, number> = { a1: 1, a2: 2, b1: 3, b2: 4, c1: 5 };
/** 每个单元的读物篇数:A1 两篇,A2 起三篇 */
export const READERS_PER_UNIT: Record<string, number> = { a1: 2, a2: 3, b1: 3, b2: 3, c1: 3 };
export const LESSONS_PER_UNIT = 8;

/**
 * 课的顺序由 id 决定,不用手填:等级 → 单元 → 课号;读物插在课之间
 * (A1 两篇在第 4、8 课后,A2 三篇在第 3、6、8 课后)。
 * id 形如 de.a1u3.l02(第 3 单元第 2 课)、de.a2u15.r01(A2 第 15 单元第 1 篇读物)。
 * 不符合格式的 id 返回 null。
 */
export function orderFromId(id: string): number | null {
  const m = id.match(/^[a-z]{2}\.(a1|a2|b1|b2|c1)u(\d{1,2})\.(l|r)(\d{2})$/);
  if (!m) return null;
  const [, level, unit, kind, num] = m;
  const n = Number(num);
  const pos = kind === "l" ? n * 10 : Math.ceil((LESSONS_PER_UNIT * n) / READERS_PER_UNIT[level!]!) * 10 + 5;
  return LEVEL_INDEX[level!]! * 100000 + Number(unit) * 1000 + pos;
}
