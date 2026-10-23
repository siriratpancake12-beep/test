import type { LanguagePack } from "@lingo/core";
import { loaders, packs as builtinPacks, summaries } from "./index.generated";
import { createLibrary } from "./library";

/**
 * 内置课程:各页面都从这里拿课(import ... from "../content")。
 * 课和场景由 tools/gen-content-index.ts 在构建时校验、排好顺序,生成 index.generated.ts 和 <语种>.generated.ts;
 * 启动时只有语言包和摘要,某个语种的课第一次用到时才解析(见 library.ts)。
 * 正式版不再在手机上逐节校验;开发版第一次加载时对一遍 schema,内容和代码对不上时提示重新生成。
 */
const library = createLibrary(
  { packs: builtinPacks, summaries, loaders },
  { validate: typeof __DEV__ !== "undefined" && __DEV__ },
);

export const packs: LanguagePack[] = library.packs;
export const { getPack, getLessons, getLesson, itemPool, availableLangs, comingSoonLangs, getScenarios, getScenario } = library;

export interface Speaker { name: string; nameZh?: string; gender?: "f" | "m" }

/** 课文说话人:语言包 cast 里的名字和性别(按性别选朗读声音);没登记的显示原 id,narrator 显示"旁白"。 */
export function speakerOf(pack: LanguagePack, id: string): Speaker {
  const c = pack.cast?.[id];
  if (c) return { name: c.name, nameZh: c.nameZh, gender: c.gender };
  return { name: id === "narrator" ? "旁白" : id };
}

/** 说话人显示成"Lena · 莉娜";没有中文名的只显示名字 */
export const speakerLabel = (sp: Speaker) => (sp.nameZh && sp.nameZh !== sp.name ? `${sp.name} · ${sp.nameZh}` : sp.name);
