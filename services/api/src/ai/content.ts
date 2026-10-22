import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LanguagePack, Scenario } from "@lingo/core";

/**
 * 服务器启动时读取并校验口语场景(content/scenarios/<lang>.json)和语言包。
 * 场景文件有错就直接启动失败:宁可部署时发现,也不要上线后学习者点进场景才报错。
 * (CI 里 core 的测试也会校验同一批文件,正常情况下坏文件到不了这里。)
 */
export interface AiContent {
  scenarios: Map<string, Scenario>;
  packs: Map<string, LanguagePack>;
}

/** 仓库根目录的 content/(生产镜像里保持同样的目录结构) */
export const CONTENT_DIR = join(import.meta.dirname, "..", "..", "..", "..", "content");

const cache = new Map<string, AiContent>();

export function loadAiContent(dir = CONTENT_DIR): AiContent {
  const hit = cache.get(dir);
  if (hit) return hit;
  const problems: string[] = [];
  const readJson = (p: string): unknown => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      problems.push(`${p}: 读不出 JSON(${(e as Error).message})`);
      return undefined;
    }
  };

  const packs = new Map<string, LanguagePack>();
  const langDir = join(dir, "languages");
  for (const f of existsSync(langDir) ? readdirSync(langDir).filter((x) => x.endsWith(".json")).sort() : []) {
    const r = LanguagePack.safeParse(readJson(join(langDir, f)));
    if (r.success) packs.set(r.data.code, r.data);
    else problems.push(`languages/${f}: 语言包格式错误`);
  }

  const scenarios = new Map<string, Scenario>();
  const scenarioDir = join(dir, "scenarios");
  for (const f of existsSync(scenarioDir) ? readdirSync(scenarioDir).filter((x) => x.endsWith(".json")).sort() : []) {
    const lang = f.replace(/\.json$/, "");
    const raw = readJson(join(scenarioDir, f));
    if (raw === undefined) continue;
    if (!packs.has(lang)) problems.push(`scenarios/${f}: 没有对应的语言包 languages/${lang}.json`);
    if (!Array.isArray(raw)) {
      problems.push(`scenarios/${f}: 应该是场景数组`);
      continue;
    }
    raw.forEach((item, i) => {
      const r = Scenario.safeParse(item);
      const where = `scenarios/${f} #${i + 1}${r.success ? `(${r.data.id})` : ""}`;
      if (!r.success) {
        problems.push(`${where}: ${r.error.issues.slice(0, 3).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
        return;
      }
      const s = r.data;
      if (s.lang !== lang || !s.id.startsWith(`${lang}.`)) problems.push(`${where}: 语种和文件名不一致`);
      if (scenarios.has(s.id)) problems.push(`${where}: 场景 id 重复`);
      scenarios.set(s.id, s);
    });
  }

  if (problems.length) throw new Error(`口语场景或语言包有错误,服务器不能启动:\n${problems.join("\n")}`);
  const content = { scenarios, packs };
  cache.set(dir, content);
  return content;
}
