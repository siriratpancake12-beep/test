// 由 tools/gen-content-index.ts 生成,不要手改。
import p_de from "../../../content/languages/de.json";
import l0 from "../../../content/courses/de/a1u1.l01.json";
import l1 from "../../../content/courses/de/a1u1.l02.json";
import p_en from "../../../content/languages/en.json";
import l2 from "../../../content/courses/en/a1u1.l01.json";
import p_es from "../../../content/languages/es.json";
import p_fr from "../../../content/languages/fr.json";
import l3 from "../../../content/courses/fr/a1u1.l01.json";
import l4 from "../../../content/courses/fr/a1u1.l02.json";
import p_it from "../../../content/languages/it.json";
import p_ja from "../../../content/languages/ja.json";
import p_ko from "../../../content/languages/ko.json";
import p_ru from "../../../content/languages/ru.json";
import s_de from "../../../content/scenarios/de.json";
import s_en from "../../../content/scenarios/en.json";
import s_fr from "../../../content/scenarios/fr.json";

export const rawPacks: unknown[] = [
  p_de,
  p_en,
  p_es,
  p_fr,
  p_it,
  p_ja,
  p_ko,
  p_ru,
];

export const rawLessons: Record<string, unknown[]> = {
  de: [l0, l1],
  en: [l2],
  es: [],
  fr: [l3, l4],
  it: [],
  ja: [],
  ko: [],
  ru: [],
};

export const rawScenarios: Record<string, unknown[]> = {
  de: s_de as unknown[],
  en: s_en as unknown[],
  fr: s_fr as unknown[],
};
