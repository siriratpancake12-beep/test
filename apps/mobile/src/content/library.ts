import { Lesson, Scenario, type Cefr, type Item, type LanguagePack } from "@lingo/core";

/**
 * 内置课程的加载和缓存。content/index.ts 用生成的索引建一份给各页面用;压测(tools/bench-content.ts)
 * 和端到端测试也用它读 App 实际打包的内容。
 *
 * - 语言包和每个语种的摘要启动时就有(很小);某个语种的课和场景第一次用到时才 JSON.parse,之后一直缓存。
 *   所以"有哪些语种可以学"不用解析任何一节课,启动时也不会把别的语种的课读进内存。
 * - 课在构建时(tools/gen-content-index.ts)已经用 zod 校验过、填好默认值、按顺序排好,正式版不再校验。
 *   开发版(validate)第一次加载时再对一遍现在的 schema:改了 schema 忘了重新生成内容,马上能看到提示。
 * - 返回的数组是缓存里的同一份(和以前一样),调用方不要原地修改,要排序先复制。
 */

/** 一个语种的摘要(生成器写进 index.generated.ts) */
export interface LangSummary {
  /** 课数(含读物) */
  lessons: number;
  units: number;
  /** 有课的等级,从低到高 */
  levels: Cefr[];
  /** AI 口语场景数 */
  scenarios: number;
}

export interface ContentIndex {
  packs: LanguagePack[];
  summaries: Record<string, LangSummary>;
  /** 返回这个语种的课和场景(JSON 字符串)。没有课也没有场景的语种没有这一项 */
  loaders: Record<string, () => string>;
}

interface LangContent {
  lessons: Lesson[];
  scenarios: Scenario[];
  byId: Map<string, Lesson>;
  /** 词条池:第一次 itemPool 时才建 */
  items?: Item[];
}

export function createLibrary(index: ContentIndex, opts: { validate?: boolean } = {}) {
  const packsByCode = new Map(index.packs.map((p) => [p.code as string, p]));
  const cache = new Map<string, LangContent>();
  const lessonCount = (code: string) => index.summaries[code]?.lessons ?? 0;

  function load(code: string): LangContent {
    const hit = cache.get(code);
    if (hit) return hit;
    const loader = index.loaders[code];
    // 不认识的语种(比如坏掉的路由参数)不进缓存,免得缓存越积越多
    if (!loader) return { lessons: [], scenarios: [], byId: new Map(), items: [] };
    let c: LangContent = { lessons: [], scenarios: [], byId: new Map(), items: [] };
    try {
      const raw = JSON.parse(loader()) as { lessons: Lesson[]; scenarios: Scenario[] };
      if (opts.validate) check(code, raw);
      c = { lessons: raw.lessons, scenarios: raw.scenarios, byId: new Map(raw.lessons.map((l) => [l.id, l])) };
    } catch (e) {
      // 生成的文件坏了(构建时校验过,不应该发生):这个语种当作没有课,不让 App 崩
      console.error(`内置课程加载失败:${code}`, e);
    }
    cache.set(code, c);
    return c;
  }

  /** 课 id、场景 id 都以语种开头(de.a1u1.l01、de.cafe_order):只加载这一个语种 */
  const langOf = (id: string) => (typeof id === "string" ? id.slice(0, 2) : "");
  const getScenarios = (code: string): Scenario[] => load(code).scenarios;
  return {
    packs: index.packs,
    getPack: (code: string) => packsByCode.get(code),
    getLessons: (code: string): Lesson[] => load(code).lessons,
    getLesson: (id: string): Lesson | undefined => load(langOf(id)).byId.get(id),
    /** 这门课全部的新词(出干扰项、复习用),按语种缓存 */
    itemPool: (code: string): Item[] => {
      const c = load(code);
      return (c.items ??= c.lessons.flatMap((l) => l.newItems));
    },
    /** 有课的语种排前面;没课的显示"即将上线"。只看摘要,不加载课 */
    availableLangs: () => index.packs.filter((p) => lessonCount(p.code) > 0),
    comingSoonLangs: () => index.packs.filter((p) => lessonCount(p.code) === 0),
    /** AI 口语场景(content/scenarios/<lang>.json)。还没有场景的语种返回空数组,页面显示"即将开放" */
    getScenarios,
    getScenario: (id: string): Scenario | undefined => getScenarios(langOf(id)).find((s) => s.id === id),
    /** 已经加载了哪些语种(测试、压测看懒加载有没有生效) */
    loadedLangs: () => [...cache.keys()],
  };
}

/** 开发版:内置内容和现在的 schema 对一遍。只提示,不改数据(正式版用的就是这份数据) */
function check(code: string, raw: { lessons: unknown[]; scenarios: unknown[] }) {
  const bad = [
    ...raw.lessons.flatMap((l) => {
      const r = Lesson.safeParse(l);
      return r.success ? [] : [`${(l as { id?: string }).id}: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`];
    }),
    ...raw.scenarios.flatMap((s) => {
      const r = Scenario.safeParse(s);
      return r.success ? [] : [`${(s as { id?: string }).id}: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`];
    }),
  ];
  if (bad.length) console.warn(`内置的${code}课程和现在的格式对不上(运行 npm run content:index 重新生成):\n${bad.slice(0, 10).join("\n")}`);
}
