import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { storage as Storage } from "./storage";
import {
  applySubEvent, emptyProgress, isPremium, mergeProgress,
  type AuthResult, type Progress, type SubEvent, type Subscription, type User,
} from "@lingo/core";
import { flushAnalytics, resetAnalytics, setAnalyticsConsent, setAnalyticsLang, track } from "./analytics";
import { getToken, onUnauthorized, serverEnabled, setToken } from "./api";
import { clearSession, deleteAccountOnServer, loadSession, saveSession, type LoginMethod } from "./auth";
import { clearConsent, isCurrent, readConsent, saveConsent, type Consent } from "./consent";
import { availableLangs, packs } from "./content";
import { createSyncer, isBlank, localTz, parseProgress, sameProgress } from "./sync";

/**
 * 本地存储(SQLite):当前语种、各语种进度、会员状态、隐私同意、学习提醒开关。离线可用;
 * 登录后由 sync.ts 和服务器合并。进度写入做了合并:连续答题时 0.5 秒内只写一次,App 切到后台时立刻写。
 * 登录凭证不在这里存,在系统安全存储里(auth.ts)。
 */
const KEY_LANG = "currentLang";
const KEY_SUB = "subscription";
const KEY_PAYWALL = "lastPaywall";
/** 学习提醒开关:"off" = 关;没有记录 = 开(默认) */
const KEY_REMINDERS = "reminders";
/** 本机学习记录属于哪个账号(最近登录的账号 id)。换另一个账号登录时先问,不把两个人的进度混在一起 */
const KEY_OWNER = "account:owner";
const keyProgress = (lang: string) => `progress:${lang}`;

/** 学习提醒开关(notify.ts 排提醒时看它;扣费前的提醒是法规要求,不受这个开关影响) */
export const remindersEnabled = async () => (await Storage.getItem(KEY_REMINDERS)) !== "off";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 学完一课、做完一次复习或专练、做完分级测试、改了目标:这些时候同步一次 */
const sessions = (p: Progress) => Object.values(p.log).reduce((a, d) => a + (d.reviewSessions ?? 0) + d.drills, 0);
const milestone = (a: Progress, b: Progress) =>
  Object.keys(a.completed).length !== Object.keys(b.completed).length || a.skipped.length !== b.skipped.length
  || a.goal !== b.goal || sessions(a) !== sessions(b);

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

  /** 已经同意了现在这一版《用户协议》《隐私政策》 */
  consented: boolean;
  /** 本机的同意记录(可能是旧版本);没同意过是 null */
  consent: Consent | null;
  agree: () => Promise<void>;
  /** 撤回同意:停止收集,本机退出登录,回到同意页(本机的学习记录保留) */
  withdrawConsent: () => Promise<void>;

  /** 登录的账号;没登录、没配服务器都是 null */
  user: User | null;
  /** 刚才因为登录过期被退出了(设置页提示重新登录) */
  loginExpired: boolean;
  /** 这次登录的账号和本机学习记录的主人不是同一个人(需要用户确认后才能登录) */
  ownerConflict: (userId: string) => Promise<boolean>;
  /** 登录成功。replaceLocal:清空本机记录,改用这个账号的云端进度(换账号时用户确认过) */
  signIn: (r: AuthResult, method: LoginMethod, replaceLocal?: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  /** 注销账号:服务器删除成功后清空本机全部数据,回到第一次打开的状态。失败抛出 ApiFailure */
  deleteAccount: () => Promise<void>;
  /** 本次打开后最近一次同步成功的时间 */
  syncedAt: string | null;

  /** 学习提醒开关 */
  reminders: boolean;
  setReminders: (on: boolean) => Promise<void>;
}
const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [lastPaywall, setLastPaywall] = useState<string | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loginExpired, setLoginExpired] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [reminders, setRemindersState] = useState(true);
  const pending = useRef<Progress | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consented = isCurrent(consent);
  /** 给同步用的最新状态(同步在 React 之外跑) */
  const live = useRef({ lang, progress, consented });
  useEffect(() => { live.current = { lang, progress, consented }; });

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) Storage.setItem(keyProgress(p.lang), JSON.stringify(p)).catch((e) => console.warn("保存进度失败", e));
  }, []);

  const [syncer] = useState(() => createSyncer({
    enabled: () => live.current.consented,
    read: async (l) => {
      const cur = pending.current ?? live.current.progress;
      if (cur?.lang === l) return cur;
      const s = await Storage.getItem(keyProgress(l));
      return s ? parseProgress(s) : null;
    },
    write: async (l, remote) => {
      if (live.current.lang === l && live.current.progress?.lang === l) {
        // 当前语种:和内存里最新的再合并一次(同步期间可能又答了题);内容没变就不更新,界面不闪
        setProgress((cur) => {
          if (!cur || cur.lang !== l) return cur;
          const next = mergeProgress(cur, remote);
          if (sameProgress(next, cur)) return cur;
          pending.current = next;
          if (!timer.current) timer.current = setTimeout(flush, 500);
          return next;
        });
        return;
      }
      const s = await Storage.getItem(keyProgress(l));
      const local = s ? parseProgress(s) : null;
      const next = local ? mergeProgress(local, remote) : remote;
      if (!local || !sameProgress(next, local)) await Storage.setItem(keyProgress(l), JSON.stringify(next));
    },
    onSynced: () => setSyncedAt(new Date().toISOString()),
  }));

  const load = useCallback(async (l: string | null) => {
    if (!l) return setProgress(null);
    const s = await Storage.getItem(keyProgress(l));
    setProgress(s ? parseProgress(s) : emptyProgress(l, localTz()));
  }, []);

  /** 本机退出登录(学习记录保留) */
  const localSignOut = useCallback(async () => {
    syncer.cancel();
    setToken(null);
    setUser(null);
    await clearSession();
  }, [syncer]);

  useEffect(() => {
    (async () => {
      const [l, s, pw, c, rem, session, owner] = await Promise.all([
        Storage.getItem(KEY_LANG), Storage.getItem(KEY_SUB), Storage.getItem(KEY_PAYWALL), readConsent(),
        Storage.getItem(KEY_REMINDERS), loadSession(), Storage.getItem(KEY_OWNER),
      ]);
      setLangState(l);
      setSub(s ? (JSON.parse(s) as Subscription) : null);
      setLastPaywall(pw);
      setConsent(c);
      setRemindersState(rem !== "off");
      // 同意前什么都不记;语种先告诉埋点,这次的 app_open 才带得上
      setAnalyticsLang(l);
      void setAnalyticsConsent(isCurrent(c));
      if (session && owner !== session.user.id) {
        // 凭证还在、本机记录却没了:iOS 卸载重装后钥匙串里的东西会留下来。当作没登录,不悄悄恢复
        await clearSession();
      } else if (session && serverEnabled()) {
        setToken(session.token);
        setUser(session.user);
      }
      await load(l);
      setReady(true);
    })();
    // 登录过期(服务器返回 401):本机退出登录,设置页提示重新登录
    onUnauthorized(() => {
      setLoginExpired(true);
      void localSignOut();
    });
    const appState = AppState.addEventListener("change", (st) => {
      if (st !== "active") flush();
      else syncer.request(live.current.lang);
    });
    return () => {
      onUnauthorized(null);
      appState.remove();
      flush();
    };
  }, [load, flush, localSignOut, syncer]);

  // 启动、登录、换语种后同步当前语种
  useEffect(() => {
    if (ready && consented && user && lang) syncer.request(lang);
  }, [ready, consented, user?.id, lang, syncer]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setAnalyticsLang(lang), [lang]);

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
      if (milestone(cur, next)) syncer.request(next.lang);
      return next;
    });
  }, [flush, syncer]);

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

  const agree = useCallback(async () => {
    setConsent(await saveConsent());
    void setAnalyticsConsent(true);
  }, []);

  const withdrawConsent = useCallback(async () => {
    await localSignOut();
    await resetAnalytics();
    await clearConsent();
    setConsent(null);
  }, [localSignOut]);

  /** 清空本机各语种的进度(换账号登录时,用户确认过) */
  const wipeProgress = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    await Promise.all([...packs.map((p) => Storage.removeItem(keyProgress(p.code))), Storage.removeItem(KEY_OWNER)]);
    setProgress((cur) => (cur ? emptyProgress(cur.lang, localTz()) : cur));
  }, []);

  const ownerConflict = useCallback(async (userId: string) => {
    const owner = await Storage.getItem(KEY_OWNER);
    if (!owner || owner === userId) return false;
    // 本机根本没有学习记录,就不用问
    const cur = pending.current ?? live.current.progress;
    if (cur && !isBlank(cur)) return true;
    const stored = await Promise.all(packs.map((p) => Storage.getItem(keyProgress(p.code))));
    return stored.some(Boolean);
  }, []);

  const signIn = useCallback(async (r: AuthResult, method: LoginMethod, replaceLocal = false) => {
    if (replaceLocal) await wipeProgress();
    // 先存好凭证再切换:存失败(抛给登录页显示)时内存里也还是没登录,不会半登录
    await saveSession({ token: r.token, user: r.user });
    await Storage.setItem(KEY_OWNER, r.user.id);
    setToken(r.token);
    setUser(r.user);
    setLoginExpired(false);
    track("login", { method, isNew: r.isNew });
    // 马上把有课的语种都同步一遍:换了新手机的,别的语种的进度也一起恢复
    void syncer.now(availableLangs().map((p) => p.code));
  }, [wipeProgress, syncer]);

  const signOut = useCallback(async () => {
    // 退出前把最后学的内容传上去(最多等 3 秒,离线就算了)
    const l = live.current.lang;
    if (getToken() && l) await Promise.race([syncer.now([l]), sleep(3000)]);
    track("logout");
    await localSignOut();
  }, [syncer, localSignOut]);

  /** 回到第一次打开的状态:删掉本机的全部数据(包括同意记录) */
  const resetDevice = useCallback(async () => {
    syncer.cancel();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    setToken(null);
    await resetAnalytics();
    await clearSession();
    // 个别键删除失败也要继续:账号已经在服务器上删掉了,界面必须回到第一次打开的状态
    const keys = [KEY_LANG, KEY_SUB, KEY_PAYWALL, KEY_REMINDERS, KEY_OWNER, ...packs.map((p) => keyProgress(p.code))];
    await Promise.all(keys.map((k) => Storage.removeItem(k).catch((e) => console.warn("清除本机数据失败", k, e))));
    await clearConsent().catch((e) => console.warn("清除同意记录失败", e));
    setUser(null);
    setLoginExpired(false);
    setSyncedAt(null);
    setLangState(null);
    setProgress(null);
    setSub(null);
    setLastPaywall(null);
    setRemindersState(true);
    setConsent(null);
  }, [syncer]);

  const deleteAccount = useCallback(async () => {
    // 服务器删除失败就直接抛给界面,本机什么都不动
    await deleteAccountOnServer();
    syncer.cancel();
    setToken(null);
    track("account_delete");
    // 尽量把最后几条事件传上去(已经不带凭证了),传不上就算了
    await flushAnalytics(3000);
    await resetDevice();
  }, [syncer, resetDevice]);

  const setReminders = useCallback(async (on: boolean) => {
    setRemindersState(on);
    await Storage.setItem(KEY_REMINDERS, on ? "on" : "off").catch((e) => console.warn("保存提醒设置失败", e));
  }, []);

  const premium = isPremium(sub, new Date());
  const value = useMemo(
    () => ({
      ready, lang, progress, sub, premium, lastPaywall, setLang, update, applySub, markPaywall,
      consented, consent, agree, withdrawConsent,
      user, loginExpired, ownerConflict, signIn, signOut, deleteAccount, syncedAt,
      reminders, setReminders,
    }),
    [
      ready, lang, progress, sub, premium, lastPaywall, setLang, update, applySub, markPaywall,
      consented, consent, agree, withdrawConsent,
      user, loginExpired, ownerConflict, signIn, signOut, deleteAccount, syncedAt,
      reminders, setReminders,
    ],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useStore 必须在 StoreProvider 里用");
  return c;
}
