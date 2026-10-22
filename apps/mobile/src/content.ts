import { LanguagePack, Lesson, Scenario, type Item } from "@lingo/core";
import { rawLessons, rawPacks, rawScenarios } from "./content.generated";

/** 内置课程(启动时校验一遍格式;格式不对的课直接不显示,不让 App 崩)。 */
export const packs: LanguagePack[] = rawPacks.map((p) => LanguagePack.parse(p));

const lessonsByLang = new Map<string, Lesson[]>();
for (const [code, list] of Object.entries(rawLessons)) {
  const ok = list.flatMap((raw) => {
    const r = Lesson.safeParse(raw);
    if (!r.success) console.warn("课程格式错误", (raw as { id?: string }).id, r.error.message);
    return r.success ? [r.data] : [];
  });
  lessonsByLang.set(code, ok.sort((a, b) => a.order - b.order));
}

export const getPack = (code: string) => packs.find((p) => p.code === code);
export const getLessons = (code: string) => lessonsByLang.get(code) ?? [];
export const getLesson = (id: string) => getLessons(id.slice(0, 2)).find((l) => l.id === id);
export const itemPool = (code: string): Item[] => getLessons(code).flatMap((l) => l.newItems);

/** 有课的语种排前面;没课的显示"即将上线"。 */
export const availableLangs = () => packs.filter((p) => getLessons(p.code).length > 0);
export const comingSoonLangs = () => packs.filter((p) => getLessons(p.code).length === 0);

/**
 * AI 口语场景(content/scenarios/<lang>.json,一个数组)。和课程一样:格式不对的跳过,不让 App 崩;
 * 还没有场景文件的语种返回空数组,页面显示"即将开放"。
 */
const scenariosByLang = new Map<string, Scenario[]>();
for (const [code, list] of Object.entries(rawScenarios)) {
  scenariosByLang.set(code, list.flatMap((raw) => {
    const r = Scenario.safeParse(raw);
    if (!r.success) console.warn("口语场景格式错误", (raw as { id?: string } | null)?.id, r.error.message);
    return r.success && r.data.lang === code ? [r.data] : [];
  }));
}

export const getScenarios = (code: string): Scenario[] => scenariosByLang.get(code) ?? [];
export const getScenario = (id: string) => getScenarios(id.slice(0, 2)).find((s) => s.id === id);

export interface Speaker { name: string; nameZh?: string; gender?: "f" | "m" }

/** 课文说话人:语言包 cast 里的名字和性别(按性别选朗读声音);没登记的显示原 id,narrator 显示"旁白"。 */
export function speakerOf(pack: LanguagePack, id: string): Speaker {
  const c = pack.cast?.[id];
  if (c) return { name: c.name, nameZh: c.nameZh, gender: c.gender };
  return { name: id === "narrator" ? "旁白" : id };
}

/** 说话人显示成"Lena · 莉娜";没有中文名的只显示名字 */
export const speakerLabel = (sp: Speaker) => (sp.nameZh && sp.nameZh !== sp.name ? `${sp.name} · ${sp.nameZh}` : sp.name);
