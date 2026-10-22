import { LanguagePack, Lesson, type Item } from "@lingo/core";
import { rawLessons, rawPacks } from "./content.generated";

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
