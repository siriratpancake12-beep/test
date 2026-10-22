import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { storage as Storage } from "./storage";
import { applySubEvent, emptyProgress, isPremium, normalizeProgress, type Progress, type SubEvent, type Subscription } from "@lingo/core";

/**
 * 本地存储(SQLite):当前语种、各语种进度、会员状态。离线可用;联网后由同步服务合并(待做)。
 * 进度写入做了合并:连续答题时 0.5 秒内只写一次,App 切到后台时立刻写。
 */
const KEY_LANG = "currentLang";
const KEY_SUB = "subscription";
const KEY_PAYWALL = "lastPaywall";
const keyProgress = (lang: string) => `progress:${lang}`;
/** 当地时区偏移(分钟),北京时间 480 */
const localTz = () => -new Date().getTimezoneOffset();

const DATE_KEYS = new Set(["due", "last_review"]);
function revive(json: string): Progress {
  const raw = JSON.parse(json, (k, v) => (DATE_KEYS.has(k) && typeof v === "string" ? new Date(v) : v));
  return { ...normalizeProgress(raw), tz: localTz() };
}

interface Ctx {
  ready: boolean;
  lang: string | null;
  progress: Progress | null;
  sub: Subscription | null;
  premium: boolean;
  lastPaywall: string | null;
  setLang: (lang: string | null) => Promise<void>;
  update: (fn: (p: Progress) => Progress) => void;
  applySub: (events: SubEvent[]) => void;
  markPaywall: () => void;
}
const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [lastPaywall, setLastPaywall] = useState<string | null>(null);
  const pending = useRef<Progress | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) Storage.setItem(keyProgress(p.lang), JSON.stringify(p)).catch((e) => console.warn("保存进度失败", e));
  }, []);

  const load = useCallback(async (l: string | null) => {
    if (!l) return setProgress(null);
    const s = await Storage.getItem(keyProgress(l));
    setProgress(s ? revive(s) : emptyProgress(l, localTz()));
  }, []);

  useEffect(() => {
    (async () => {
      const [l, s, pw] = await Promise.all([Storage.getItem(KEY_LANG), Storage.getItem(KEY_SUB), Storage.getItem(KEY_PAYWALL)]);
      setLangState(l);
      setSub(s ? (JSON.parse(s) as Subscription) : null);
      setLastPaywall(pw);
      await load(l);
      setReady(true);
    })();
    const appState = AppState.addEventListener("change", (st) => st !== "active" && flush());
    return () => {
      appState.remove();
      flush();
    };
  }, [load, flush]);

  const setLang = useCallback(async (l: string | null) => {
    flush();
    if (l) await Storage.setItem(KEY_LANG, l);
    else await Storage.removeItem(KEY_LANG);
    setLangState(l);
    await load(l);
  }, [load, flush]);

  const update = useCallback((fn: (p: Progress) => Progress) => {
    setProgress((cur) => {
      if (!cur) return cur;
      const next = fn(cur);
      pending.current = next;
      if (!timer.current) timer.current = setTimeout(flush, 500);
      return next;
    });
  }, [flush]);

  const applySub = useCallback((events: SubEvent[]) => {
    setSub((cur) => {
      const next = events.reduce<Subscription | null>((s, e) => applySubEvent(s, e), cur);
      if (next) Storage.setItem(KEY_SUB, JSON.stringify(next)).catch((e) => console.warn("保存会员状态失败", e));
      return next;
    });
  }, []);

  const markPaywall = useCallback(() => {
    const t = new Date().toISOString();
    setLastPaywall(t);
    Storage.setItem(KEY_PAYWALL, t).catch(() => {});
  }, []);

  const premium = isPremium(sub, new Date());
  const value = useMemo(
    () => ({ ready, lang, progress, sub, premium, lastPaywall, setLang, update, applySub, markPaywall }),
    [ready, lang, progress, sub, premium, lastPaywall, setLang, update, applySub, markPaywall],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useStore 必须在 StoreProvider 里用");
  return c;
}
