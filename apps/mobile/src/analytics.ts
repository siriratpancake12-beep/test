import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { AppState, Platform } from "react-native";
import { AppEvent, EventsRes, ROUTES, type EventName } from "@lingo/core";
import { api, ApiFailure, serverEnabled } from "./api";
import { storage } from "./storage";

/**
 * 埋点。各页面直接调用 track(名字, 属性);事件名和属性见 packages/core/src/events.ts。
 *
 * - 用户同意《隐私政策》之前什么都不记:store.tsx 读完本机的同意记录后调用 setAnalyticsConsent;
 *   在那之前的事件只放在内存里,没同意就扔掉。
 * - anonId 是第一次同意时随机生成的,存在普通存储里(卸载就没了),不读任何设备标识。
 * - 事件先进本机队列,攒够 20 条、每 60 秒、App 切到后台时上传;上传失败的留着下次再传。
 *   没配服务器时只保留最近 500 条(离线很久也不会无限增长)。
 * - 属性按事件名白名单过滤(只收 events.ts 里列出的),字符串截到 200 字;不要传用户输入的内容。
 */
type Props = Record<string, string | number | boolean | null>;

/** 各事件收哪些属性,和 events.ts 的说明一致。events.ts 加了事件,这里不补会编译不过 */
const PROPS: Record<EventName, readonly string[]> = {
  app_open: [],
  onboarding_complete: ["goalKind", "target", "dailyMinutes", "hasDeadline", "hasBase"],
  placement_complete: ["passedLevels", "questions", "correct"],
  plan_view: ["first"],
  lesson_start: ["lessonId"],
  lesson_complete: ["lessonId", "correct", "total", "seconds"],
  review_complete: ["cards", "correct"],
  drill_complete: ["weakness", "total", "correct"],
  checkpoint_complete: ["unit", "score", "total"],
  paywall_view: ["reason"],
  trial_start: ["productId"],
  purchase: ["productId"],
  restore: ["found"],
  report_view: ["premium"],
  notification_prompt: ["granted"],
  login: ["method", "isNew"],
  logout: [],
  account_delete: [],
  tutor_message: ["scenarioId"],
  speech_attempt: ["scored", "score"],
  goal_change: ["target", "dailyMinutes"],
};

const KEY_QUEUE = "analytics:queue";
const KEY_ANON = "analytics:anonId";
const BATCH = 20;
/** 一次请求最多 200 条(接口约定 EventsReq) */
const MAX_PER_REQUEST = 200;
const MAX_KEEP = 500;
const UPLOAD_EVERY_MS = 60_000;
/** 切到后台超过 30 分钟再回来,算一次新的打开 */
const SESSION_GAP_MS = 30 * 60_000;

const platform: AppEvent["platform"] = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
const appVersion = (Constants.expoConfig?.version ?? "0.0.0").slice(0, 32);
const randomId = () => Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");

interface Draft { name: EventName; props: Props; at: string; lang?: string }

/** waiting = 还不知道有没有同意;on = 记录;off = 没同意,什么都不记 */
let mode: "waiting" | "on" | "off" = "waiting";
let early: Draft[] = [];
let queue: AppEvent[] = [];
let anonId = "";
let lang: string | undefined;
/** 撤回同意、注销后作废正在进行的读写和上传 */
let generation = 0;
/** lesson_start 的时间,lesson_complete 用来算用了多少秒(页面不用自己计时) */
const lessonStarted = new Map<string, number>();
let backgroundAt = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
let listening = false;

function clean(name: EventName, props: Props): Props {
  const allowed = PROPS[name];
  const out: Props = {};
  for (const k of allowed) {
    const v = props[k];
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean" || v === null) out[k] = v;
  }
  if (__DEV__) for (const k of Object.keys(props)) if (!allowed.includes(k)) console.warn(`埋点 ${name} 不收属性 ${k}(见 events.ts)`);
  return out;
}

/** 记一条行为数据。不会抛错,也不会卡界面。 */
export function track(name: EventName, props: Record<string, string | number | boolean | null> = {}): void {
  try {
    if (mode === "off") return;
    const now = Date.now();
    const p = clean(name, props);
    const lessonId = typeof p.lessonId === "string" ? p.lessonId : null;
    if (name === "lesson_start" && lessonId) lessonStarted.set(lessonId, now);
    if (name === "lesson_complete" && lessonId) {
      const t0 = lessonStarted.get(lessonId);
      if (t0 && p.seconds === undefined) p.seconds = Math.round((now - t0) / 1000);
      lessonStarted.delete(lessonId);
    }
    const d: Draft = { name, props: p, at: new Date(now).toISOString(), lang };
    if (mode === "waiting") {
      if (early.length < 50) early.push(d);
      return;
    }
    enqueue(d);
  } catch (e) {
    console.warn("埋点出错", e);
  }
}

function enqueue(d: Draft) {
  const ev = AppEvent.safeParse({ id: randomId(), anonId, platform, appVersion, ...d });
  // 不合格式的事件会让整批上传被服务器拒掉,宁可丢这一条
  if (!ev.success) {
    if (__DEV__) console.warn("埋点格式不对,已丢弃", d.name, ev.error.issues[0]?.message);
    return;
  }
  queue.push(ev.data);
  if (queue.length > MAX_KEEP) queue.splice(0, queue.length - MAX_KEEP);
  save();
  if (queue.length >= BATCH) void upload();
}

let saving: Promise<unknown> = Promise.resolve();
function save() {
  const gen = generation;
  saving = saving
    .then(() => (gen === generation && mode === "on" ? storage.setItem(KEY_QUEUE, JSON.stringify(queue)) : undefined))
    .catch((e) => console.warn("保存埋点失败", e));
}

function parseQueue(raw: string | null): AppEvent[] {
  try {
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    return Array.isArray(list) ? list.flatMap((x) => { const r = AppEvent.safeParse(x); return r.success ? [r.data] : []; }).slice(-MAX_KEEP) : [];
  } catch {
    return [];
  }
}

let uploading = false;
let uploadDone: Promise<void> = Promise.resolve();
/** 上传队列里的事件。同一时间只有一个上传;失败的留在队列里下次再传。 */
function upload(): Promise<void> {
  if (uploading) return uploadDone;
  if (mode !== "on" || !serverEnabled() || !queue.length) return Promise.resolve();
  uploading = true;
  const gen = generation;
  uploadDone = (async () => {
    try {
      while (mode === "on" && gen === generation && queue.length) {
        const batch = queue.slice(0, MAX_PER_REQUEST);
        try {
          await api("POST", ROUTES.events, { events: batch }, EventsRes);
        } catch (e) {
          // 网络不通、服务器忙、凭证失效:留着下次传。其他 4xx 是这批数据本身被拒,重传也没用,丢掉
          const retry = !(e instanceof ApiFailure) || e.status === 0 || e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500;
          if (retry) return;
        }
        if (gen !== generation) return;
        const sent = new Set(batch.map((e) => e.id));
        queue = queue.filter((e) => !sent.has(e.id));
        save();
      }
    } finally {
      uploading = false;
    }
  })();
  return uploadDone;
}

function listen() {
  if (serverEnabled() && !ticker) ticker = setInterval(() => void upload(), UPLOAD_EVERY_MS);
  if (listening) return;
  listening = true;
  AppState.addEventListener("change", (st) => {
    if (st === "background") {
      backgroundAt = Date.now();
      void upload();
    } else if (st === "active") {
      if (backgroundAt && Date.now() - backgroundAt >= SESSION_GAP_MS) track("app_open");
      backgroundAt = 0;
    }
  });
}

/**
 * 隐私同意的状态(store.tsx 在启动读完同意记录、用户点同意、撤回同意时调用)。
 * 同意:读出(或第一次生成)anonId 和本机队列,记一次 app_open,开始定时上传。
 */
export async function setAnalyticsConsent(granted: boolean): Promise<void> {
  if (!granted) {
    mode = "off";
    early = [];
    return;
  }
  if (mode === "on") return;
  mode = "waiting";
  const gen = generation;
  let id: string | null = null;
  let saved: string | null = null;
  try {
    [id, saved] = await Promise.all([storage.getItem(KEY_ANON), storage.getItem(KEY_QUEUE)]);
  } catch (e) {
    console.warn("读取埋点队列失败", e);
  }
  if (gen !== generation || mode !== "waiting") return;
  anonId = id ?? randomId();
  if (!id) storage.setItem(KEY_ANON, anonId).catch((e) => console.warn("保存 anonId 失败", e));
  queue = parseQueue(saved);
  mode = "on";
  const pending = early;
  early = [];
  track("app_open");
  for (const d of pending) enqueue(d);
  listen();
}

/** 当前语种(事件带上 lang,按语种看留存和学习效果) */
export const setAnalyticsLang = (l: string | null) => { lang = l ?? undefined; };

/** 马上上传(注销账号前把最后的事件发出去),最多等 timeoutMs,不会抛错 */
export function flushAnalytics(timeoutMs = 3000): Promise<void> {
  return Promise.race([upload(), new Promise<void>((r) => setTimeout(r, timeoutMs))]).catch(() => {});
}

/** 撤回同意、注销账号:停止记录,删掉本机的队列和 anonId(重新同意后是一个新的 anonId) */
export async function resetAnalytics(): Promise<void> {
  mode = "off";
  generation++;
  early = [];
  queue = [];
  anonId = "";
  lessonStarted.clear();
  if (ticker) clearInterval(ticker);
  ticker = null;
  await saving;
  await Promise.all([storage.removeItem(KEY_QUEUE), storage.removeItem(KEY_ANON)]).catch((e) => console.warn("清除埋点数据失败", e));
}
