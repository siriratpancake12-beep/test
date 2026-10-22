import type { SpeechScoreRes } from "@lingo/core";
import { HttpError } from "../errors";
import type { SpeechScorer } from "../routes/speech";
import { checkDuration, parseWav, toPcm16kWav } from "./audio";

/**
 * Azure 发音评测(语音转文字的"短音频 REST 接口" + Pronunciation-Assessment 请求头)。
 * 支持 en-US、de-DE、fr-FR 等三十多种语言;韵律(语调)评分只有 en-US 有,所以不用。
 * 区域名以 china 开头(chinaeast2、chinanorth2、chinanorth3)时走世纪互联运营的 Azure 中国,
 * 录音不出境;否则走全球版。
 */
export interface AzureScorerOptions {
  key: string;
  region: string;
  /** 测试时传入假的 fetch */
  fetch?: typeof fetch;
  /** 把录音转成 16kHz 单声道 WAV;默认用 ffmpeg(测试时可以换掉) */
  toWav?: (audio: Buffer, mime: string) => Promise<Buffer>;
  timeoutMs?: number;
}

export function azureEndpoint(region: string, locale: string): string {
  const host = /^china/i.test(region) ? `${region}.stt.speech.azure.cn` : `${region}.stt.speech.microsoft.com`;
  return `https://${host}/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`;
}

export function createAzureScorer(o: AzureScorerOptions): SpeechScorer {
  const doFetch = o.fetch ?? fetch;
  const toWav = o.toWav ?? ((audio: Buffer, mime: string) => toPcm16kWav(audio, mime));
  return {
    async score(audio, { text, locale, mime }) {
      const wav = await toWav(audio, mime);
      const info = parseWav(wav);
      if (!info) throw new HttpError(400, "audio_invalid", "录音文件无法识别,请重新录一次");
      checkDuration(info.durationSec);

      // EnableMiscue:标出漏读、多读的词;HundredMark:0–100 分
      const params = { ReferenceText: text, GradingSystem: "HundredMark", Granularity: "Word", Dimension: "Comprehensive", EnableMiscue: "True" };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
      try {
        const res = await doFetch(azureEndpoint(o.region, locale), {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": o.key,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            Accept: "application/json",
            "Pronunciation-Assessment": Buffer.from(JSON.stringify(params), "utf8").toString("base64"),
          },
          body: new Uint8Array(wav),
          signal: ctrl.signal,
        });
        const body = await res.text();
        if (res.status === 429) throw new HttpError(503, "speech_busy", "现在评测的人太多了,请稍后再试");
        // 密钥错、区域错等:这是我们的配置问题,日志里留详情,给用户的是通用提示
        if (!res.ok) throw new Error(`Azure 发音评测 HTTP ${res.status}:${body.slice(0, 300)}`);
        return mapAzureResult(JSON.parse(body));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type Scores = { AccuracyScore?: unknown; FluencyScore?: unknown; CompletenessScore?: unknown; PronScore?: unknown; ErrorType?: unknown };
type AzureWord = Scores & { Word?: unknown; PronunciationAssessment?: Scores };
type AzureResult = { RecognitionStatus?: string; NBest?: (Scores & { PronunciationAssessment?: Scores; Words?: AzureWord[] })[] };

/** 0–100 的整数分;缺了算 0 */
const score = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : 0;
};

/** Azure 的错误类型 → 和服务商无关的代码(App 按这个显示中文说明):none / mispronunciation / omission / insertion / unexpected_break / missing_break / monotone */
const wordError = (v: unknown) =>
  typeof v === "string" && v ? v.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() : "none";

/** REST 接口把分数直接放在 NBest[0] 里,SDK 的 JSON 放在 PronunciationAssessment 里:两种都认。 */
export function mapAzureResult(data: AzureResult): SpeechScoreRes {
  const status = data.RecognitionStatus;
  // Error 是 Azure 自己出错;其他(NoMatch 没听出这种语言、InitialSilenceTimeout 只有静音、BabbleTimeout 只有噪音)是没录好
  if (status !== "Success" && (status === "Error" || !status)) throw new Error(`Azure 发音评测返回 ${status ?? "空结果"}`);
  const best = status === "Success" ? data.NBest?.[0] : undefined;
  if (!best) throw new HttpError(422, "no_speech", "没听清,请靠近话筒、用正常的音量再读一遍");
  const pa = best.PronunciationAssessment ?? best;
  return {
    score: score(pa.PronScore),
    accuracy: score(pa.AccuracyScore),
    fluency: score(pa.FluencyScore),
    completeness: score(pa.CompletenessScore),
    words: (best.Words ?? []).map((w) => {
      const wp = w.PronunciationAssessment ?? w;
      return { word: String(w.Word ?? ""), score: score(wp.AccuracyScore), error: wordError(wp.ErrorType) };
    }),
  };
}
