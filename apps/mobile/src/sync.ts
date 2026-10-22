import { mergeProgress, normalizeProgress, ProgressRes, ROUTES, type Progress } from "@lingo/core";
import { api, ApiFailure, getToken, serverEnabled } from "./api";

/**
 * 进度同步(登录后才有):换手机不丢进度、手机和平板一起用。
 *
 * 一次同步 = 取服务器的版本 → 用 core 的 mergeProgress 和本机合并(不丢任何学习记录,和顺序无关)
 * → 带 baseRev 上传 → 采用服务器返回的版本(并进本机时再和同步期间新学的内容合并一次)。
 * 启动、回到前台、学完一课/复习/专练、换语种时触发,3 秒内的多次触发只同步一次,同一时间只跑一个。
 * 离线、服务器出错都安静失败,等下次触发再试;不显示"同步中"、不打断答题,结果和本机一样时不动界面(不闪)。
 */
export const SYNC_DELAY_MS = 3000;

const DATE_KEYS = new Set(["due", "last_review"]);
/** 当地时区偏移(分钟),北京时间 480 */
export const localTz = () => -new Date().getTimezoneOffset();

/** 读进度的 JSON(本机存档或服务器返回的):复习卡的日期还原成 Date,时区按这台手机的 */
export function parseProgress(json: string): Progress {
  const raw = JSON.parse(json, (k, v) => (DATE_KEYS.has(k) && typeof v === "string" ? new Date(v) : v));
  return { ...normalizeProgress(raw), tz: localTz() };
}

const isObj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
const validDate = (d: unknown) => d instanceof Date && !Number.isNaN(d.getTime());

/**
 * 服务器返回的进度(已经是对象,日期是字符串)。语种不对、结构不对、日期坏了都返回 null:
 * 宁可这次不同步,也不能让一份坏数据进到本机把首页弄崩。
 */
export function reviveProgress(raw: unknown, lang: string): Progress | null {
  if (!isObj(raw) || (raw as { lang?: unknown }).lang !== lang) return null;
  try {
    const p = parseProgress(JSON.stringify(raw));
    const ok = [p.completed, p.learned, p.cards, p.log, p.issues, p.recent].every(isObj)
      && [p.skipped, p.frozenDays, p.hours, p.checkpoints].every(Array.isArray)
      && Object.values(p.cards).every((c) => validDate(c?.card?.due));
    return ok ? p : null;
  } catch {
    return null;
  }
}

/** 内容是否一样。mergeProgress(p, p) 会把键排好序,得到可以直接比较的 JSON */
const canon = (p: Progress) => JSON.stringify(mergeProgress(p, p));
export const sameProgress = (a: Progress, b: Progress) => canon(a) === canon(b);

/** 什么都还没有的进度(刚选完语种):不上传,免得在服务器上留一份空记录 */
export const isBlank = (p: Progress) =>
  !p.goal && !p.skipped.length && ![p.completed, p.cards, p.log].some((o) => Object.keys(o).length);

export interface SyncDeps {
  /** 本机这门语言最新的进度(当前语种用内存里的);没有返回 null */
  read: (lang: string) => Promise<Progress | null>;
  /** 把同步结果并进本机。要和"同步期间新学的内容"再合并一次,不能直接覆盖 */
  write: (lang: string, p: Progress) => Promise<void>;
}

/** 同步一门语言。出错抛出 ApiFailure,由调用方决定要不要安静地忽略。 */
export async function syncLang(lang: string, deps: SyncDeps): Promise<void> {
  let remote = await api("GET", ROUTES.progress(lang), undefined, ProgressRes);
  let server = reviveProgress(remote.progress, lang);
  const local = await deps.read(lang);
  let merged = local && server ? mergeProgress(local, server) : (local ?? server);
  if (!merged || isBlank(merged)) return;

  let final = merged;
  // 服务器上的已经包含了本机的全部内容,就不用上传
  if (!server || !sameProgress(merged, server)) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await api("PUT", ROUTES.progress(lang), { progress: merged, baseRev: remote.rev }, ProgressRes);
        final = reviveProgress(res.progress, lang) ?? merged;
        break;
      } catch (e) {
        // 409 = 刚好另一台设备先传了一版:取最新的再合并一次重传
        if (!(e instanceof ApiFailure) || e.status !== 409 || attempt >= 3) throw e;
        remote = await api("GET", ROUTES.progress(lang), undefined, ProgressRes);
        server = reviveProgress(remote.progress, lang);
        if (server) merged = mergeProgress(merged, server);
      }
    }
  }
  if (!local || !sameProgress(final, local)) await deps.write(lang, final);
}

export interface Syncer {
  /** 3 秒后同步这门语言;这期间的多次触发只同步一次 */
  request: (lang: string | null) => void;
  /** 马上同步(登录后、退出前),全部同步完(或失败)后 resolve,不会 reject */
  now: (langs: string[]) => Promise<void>;
  /** 退出登录、注销、撤回同意:取消还没开始的同步,正在进行的同步结果作废(不再写回本机) */
  cancel: () => void;
}

export function createSyncer(deps: SyncDeps & {
  /** 现在能不能同步:同意了隐私政策(登录与否看凭证) */
  enabled: () => boolean;
  onSynced?: (lang: string) => void;
}): Syncer {
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let current: Promise<void> = Promise.resolve();
  let generation = 0;

  const start = (): Promise<void> => {
    if (busy) return current;
    busy = true;
    current = (async () => {
      try {
        // 正在同步时新加的语种,这一轮接着做
        while (waiting.size) {
          const lang = waiting.values().next().value as string;
          waiting.delete(lang);
          if (!deps.enabled() || !serverEnabled() || !getToken()) continue;
          const gen = generation;
          try {
            await syncLang(lang, { read: deps.read, write: async (l, p) => { if (gen === generation) await deps.write(l, p); } });
            if (gen === generation) deps.onSynced?.(lang);
          } catch (e) {
            if (__DEV__) console.log(`同步 ${lang} 没成功,下次再试:`, (e as Error).message);
          }
        }
      } finally {
        busy = false;
      }
    })();
    return current;
  };

  return {
    request(lang) {
      if (!lang) return;
      waiting.add(lang);
      if (!timer) timer = setTimeout(() => { timer = null; void start(); }, SYNC_DELAY_MS);
    },
    now(langs) {
      for (const l of langs) waiting.add(l);
      return start();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      waiting.clear();
      generation++;
    },
  };
}
