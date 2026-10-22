import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import Storage from "expo-sqlite/kv-store";
import { emptyProgress, type Progress } from "@lingo/core";

/**
 * 本地进度存储(SQLite)。每个语种一份进度,离线可用;联网后由同步服务合并(待做)。
 * 日期字段存成字符串,读出来要还原成 Date。
 */
const KEY_LANG = "currentLang";
const keyProgress = (lang: string) => `progress:${lang}`;

function revive(json: string): Progress {
  return JSON.parse(json, (k, v) => ((k === "due" || k === "last_review") && typeof v === "string" ? new Date(v) : v));
}

interface Ctx {
  ready: boolean;
  lang: string | null;
  progress: Progress | null;
  setLang: (lang: string | null) => Promise<void>;
  update: (fn: (p: Progress) => Progress) => void;
}
const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  const load = useCallback(async (l: string | null) => {
    if (!l) return setProgress(null);
    const s = await Storage.getItem(keyProgress(l));
    setProgress(s ? revive(s) : emptyProgress(l));
  }, []);

  useEffect(() => {
    (async () => {
      const l = await Storage.getItem(KEY_LANG);
      setLangState(l);
      await load(l);
      setReady(true);
    })();
  }, [load]);

  const setLang = useCallback(async (l: string | null) => {
    if (l) await Storage.setItem(KEY_LANG, l);
    else await Storage.removeItem(KEY_LANG);
    setLangState(l);
    await load(l);
  }, [load]);

  const update = useCallback((fn: (p: Progress) => Progress) => {
    setProgress((cur) => {
      if (!cur) return cur;
      const next = fn(cur);
      Storage.setItem(keyProgress(next.lang), JSON.stringify(next)).catch((e) => console.warn("保存进度失败", e));
      return next;
    });
  }, []);

  const value = useMemo(() => ({ ready, lang, progress, setLang, update }), [ready, lang, progress, setLang, update]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useStore 必须在 StoreProvider 里用");
  return c;
}
