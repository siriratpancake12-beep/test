import { Platform } from "react-native";
import { ROUTES, SpeechScoreRes } from "@lingo/core";
import { API_BASE, getToken, serverEnabled } from "./api";

/**
 * 发音评测:把跟读的录音传给服务器打分。接口见 core 的 ROUTES.speechScore:
 * 原始音频放在请求体里,参数放在 query(?lang=de&text=...)。api() 只发 JSON,所以这里单独用 fetch 发二进制。
 *
 * 只有连了服务器、已登录、服务器开通了评测时才打分;否则跟读题让学习者自己判断"像 / 不太像"。
 * 服务器回答"没有这个功能"(还没接评测服务商)以后,这次打开 App 期间不再尝试,免得每句都白等一次。
 */
let unavailable = false;

export const canScoreSpeech = () => serverEnabled() && !!getToken() && !unavailable;

/** 录音格式:iOS 录成 16kHz 单声道 WAV(评测服务直接能用);安卓录 AAC(m4a),服务器转换 */
export const RECORDING_MIME = Platform.OS === "ios" ? "audio/wav" : "audio/mp4";

export type ScoreOutcome =
  | { kind: "scored"; result: SpeechScoreRes }
  /** 这次没打分(没开通、没登录、额度用完、网络不好……),message 是给学习者看的原因 */
  | { kind: "unscored"; message?: string };

const TIMEOUT_MS = 20000;

export async function scoreSpeech(uri: string, lang: string, text: string): Promise<ScoreOutcome> {
  if (!canScoreSpeech()) return { kind: "unscored" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // 本地录音文件 → Blob(iOS、安卓的 fetch 都能读 file:// 地址)
    const audio = await (await fetch(uri)).blob();
    const query = `?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`;
    const res = await fetch(API_BASE + ROUTES.speechScore + query, {
      method: "POST",
      headers: { "content-type": RECORDING_MIME, authorization: `Bearer ${getToken()}` },
      body: audio,
      signal: ctrl.signal,
    });
    const data: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const parsed = SpeechScoreRes.safeParse(data);
      return parsed.success ? { kind: "scored", result: parsed.data } : { kind: "unscored", message: "打分结果读不出来" };
    }
    // 404 / 501 / 503:服务器还没开通评测
    if ([404, 501, 503].includes(res.status)) unavailable = true;
    const message = (data as { error?: { message?: string } } | null)?.error?.message;
    return { kind: "unscored", ...(message ? { message } : {}) };
  } catch {
    return { kind: "unscored", message: "网络不好,这次没能打分" };
  } finally {
    clearTimeout(timer);
  }
}
