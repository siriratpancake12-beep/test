import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDuration, ffmpegToWav, normalizeAudioMime, parseWav, pcmToWav, toPcm16kWav } from "../src/ai/audio";
import { azureEndpoint, createAzureScorer, mapAzureResult } from "../src/ai/azure-speech";
import { testConfig } from "../src/config";
import { createSpeechScorer } from "../src/routes/speech";

/** 任意格式的 PCM WAV(测试转换用):440Hz 正弦波 */
function makeWav(seconds: number, sampleRate: number, channels: number): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    for (let c = 0; c < channels; c++) pcm.writeInt16LE(v, (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("录音格式", () => {
  it("读 WAV 文件头:格式、声道、采样率、时长", () => {
    const w = parseWav(makeWav(2, 44100, 2))!;
    expect(w).toMatchObject({ format: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16 });
    expect(w.durationSec).toBeCloseTo(2, 3);
    const p = parseWav(pcmToWav(Buffer.alloc(16000 * 2 * 3)))!;
    expect(p).toMatchObject({ format: 1, channels: 1, sampleRate: 16000, dataOffset: 44 });
    expect(p.durationSec).toBeCloseTo(3, 3);
    expect(parseWav(Buffer.from("not a wav file at all"))).toBeNull();
  });

  it("边录边写的 WAV(头里的长度是 0xFFFFFFFF)按实际长度算", () => {
    const w = pcmToWav(Buffer.alloc(16000 * 2));
    w.writeUInt32LE(0xffffffff, 40);
    expect(parseWav(w)!.durationSec).toBeCloseTo(1, 3);
  });

  it("content-type 归一化", () => {
    expect(normalizeAudioMime("audio/x-wav")).toBe("audio/wav");
    expect(normalizeAudioMime("Audio/M4A; foo=bar")).toBe("audio/m4a");
    expect(normalizeAudioMime("audio/x-m4a")).toBe("audio/m4a");
    expect(normalizeAudioMime("application/octet-stream")).toBeNull();
    expect(normalizeAudioMime(undefined)).toBeNull();
  });

  it("时长:最长 15 秒(留一点余量),太短的也不评测", () => {
    expect(() => checkDuration(15.4)).not.toThrow();
    expect(() => checkDuration(15.6)).toThrow(/最多 15 秒/);
    expect(() => checkDuration(0.1)).toThrow(/太短/);
  });

  it("已经是 16kHz 单声道 WAV:直接用,不调用 ffmpeg", async () => {
    const w = pcmToWav(Buffer.alloc(16000 * 2));
    expect(await toPcm16kWav(w, "audio/wav", { ffmpegPath: "/nonexistent/ffmpeg" })).toBe(w);
  });

  it("没有 ffmpeg 时返回明确的错误", async () => {
    await expect(toPcm16kWav(Buffer.from("m4a bytes"), "audio/m4a", { ffmpegPath: "/nonexistent/ffmpeg" })).rejects.toMatchObject({
      status: 503,
      code: "ffmpeg_missing",
      message: expect.stringContaining("ffmpeg"),
    });
  });

  it.skipIf(!hasFfmpeg)("ffmpeg:44.1kHz 立体声 WAV → 16kHz 单声道", async () => {
    const out = parseWav(await toPcm16kWav(makeWav(2, 44100, 2), "audio/wav"))!;
    expect(out).toMatchObject({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    expect(out.durationSec).toBeCloseTo(2, 1);
  });

  it.skipIf(!hasFfmpeg)("ffmpeg:m4a(索引在文件末尾,和手机录的一样)→ 16kHz WAV;坏文件 → 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lingo-test-"));
    try {
      const file = join(dir, "a.m4a");
      const made = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "aac", "-f", "mp4", file]);
      expect(made.status).toBe(0);
      const out = parseWav(await ffmpegToWav(readFileSync(file)))!;
      expect(out).toMatchObject({ channels: 1, sampleRate: 16000 });
      expect(out.durationSec).toBeCloseTo(1.5, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(ffmpegToWav(Buffer.from("definitely not audio"))).rejects.toMatchObject({ status: 400, code: "audio_invalid" });
  });
});

describe("Azure 发音评测", () => {
  /** 官方文档里 REST 接口的示例响应(分数直接在 NBest[0] 里) */
  const REST_RESULT = {
    RecognitionStatus: "Success",
    Offset: 700000,
    Duration: 8400000,
    DisplayText: "Guten Tag.",
    NBest: [
      {
        Confidence: 0.98,
        Lexical: "guten tag",
        AccuracyScore: 91.4,
        FluencyScore: 100,
        CompletenessScore: 100,
        PronScore: 94.6,
        Words: [
          { Word: "guten", AccuracyScore: 100, ErrorType: "None" },
          { Word: "tag", AccuracyScore: 55, ErrorType: "Mispronunciation" },
          { Word: "herr", AccuracyScore: 0, ErrorType: "Omission" },
        ],
      },
    ],
  };

  function fakeAzure(response: () => Response) {
    const requests: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), headers: init!.headers as Record<string, string>, body: init!.body as Uint8Array });
      return response();
    }) as typeof fetch;
    return { f, requests };
  }
  const oneSecond = pcmToWav(Buffer.alloc(16000 * 2));

  it("区域:全球版和 Azure 中国(世纪互联)", () => {
    expect(azureEndpoint("eastasia", "de-DE")).toBe(
      "https://eastasia.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=de-DE&format=detailed",
    );
    expect(azureEndpoint("chinanorth3", "fr-FR")).toBe(
      "https://chinanorth3.stt.speech.azure.cn/speech/recognition/conversation/cognitiveservices/v1?language=fr-FR&format=detailed",
    );
  });

  it("请求:密钥、16kHz WAV、Pronunciation-Assessment 参数;响应换成我们的格式", async () => {
    const { f, requests } = fakeAzure(() => Response.json(REST_RESULT));
    const scorer = createAzureScorer({ key: "azure-key", region: "chinaeast2", fetch: f, toWav: async (a) => a });
    const res = await scorer.score(oneSecond, { text: "Guten Tag, Herr Schulz.", locale: "de-DE", mime: "audio/wav" });
    expect(res).toEqual({
      score: 95,
      accuracy: 91,
      fluency: 100,
      completeness: 100,
      words: [
        { word: "guten", score: 100, error: "none" },
        { word: "tag", score: 55, error: "mispronunciation" },
        { word: "herr", score: 0, error: "omission" },
      ],
    });
    const r = requests[0]!;
    expect(r.url).toBe(azureEndpoint("chinaeast2", "de-DE"));
    expect(r.headers["Ocp-Apim-Subscription-Key"]).toBe("azure-key");
    expect(r.headers["Content-Type"]).toBe("audio/wav; codecs=audio/pcm; samplerate=16000");
    expect(JSON.parse(Buffer.from(r.headers["Pronunciation-Assessment"]!, "base64").toString("utf8"))).toEqual({
      ReferenceText: "Guten Tag, Herr Schulz.",
      GradingSystem: "HundredMark",
      Granularity: "Word",
      Dimension: "Comprehensive",
      EnableMiscue: "True",
    });
    expect(Buffer.from(r.body).equals(oneSecond)).toBe(true);
  });

  it("SDK 风格的结果(分数在 PronunciationAssessment 里)也能读", () => {
    const res = mapAzureResult({
      RecognitionStatus: "Success",
      NBest: [
        {
          PronunciationAssessment: { AccuracyScore: 80, FluencyScore: 70, CompletenessScore: 90, PronScore: 78 },
          Words: [{ Word: "bonjour", PronunciationAssessment: { AccuracyScore: 80, ErrorType: "UnexpectedBreak" } } as never],
        },
      ],
    });
    expect(res).toEqual({ score: 78, accuracy: 80, fluency: 70, completeness: 90, words: [{ word: "bonjour", score: 80, error: "unexpected_break" }] });
  });

  it("没听清(NoMatch / 静音)→ 422;Azure 自己出错 → 普通错误(接口返回通用提示)", () => {
    expect(() => mapAzureResult({ RecognitionStatus: "NoMatch" })).toThrow(/没听清/);
    expect(() => mapAzureResult({ RecognitionStatus: "InitialSilenceTimeout" })).toThrow(/没听清/);
    expect(() => mapAzureResult({ RecognitionStatus: "Error" })).toThrow(/Azure/);
  });

  it("HTTP 错误:限流 → 503 稍后再试;密钥错 → 普通错误", async () => {
    const busy = createAzureScorer({ key: "k", region: "eastasia", fetch: fakeAzure(() => new Response("", { status: 429 })).f, toWav: async (a) => a });
    await expect(busy.score(oneSecond, { text: "Hi", locale: "en-US", mime: "audio/wav" })).rejects.toMatchObject({ status: 503, code: "speech_busy" });
    const bad = createAzureScorer({ key: "k", region: "eastasia", fetch: fakeAzure(() => new Response("bad key", { status: 401 })).f, toWav: async (a) => a });
    await expect(bad.score(oneSecond, { text: "Hi", locale: "en-US", mime: "audio/wav" })).rejects.toThrow(/HTTP 401/);
  });

  it("转换后超过 15 秒:不调用 Azure(按时长计费)", async () => {
    const { f, requests } = fakeAzure(() => Response.json(REST_RESULT));
    const scorer = createAzureScorer({ key: "k", region: "eastasia", fetch: f, toWav: async () => pcmToWav(Buffer.alloc(16000 * 2 * 16)) });
    await expect(scorer.score(Buffer.from("m4a"), { text: "Hi", locale: "en-US", mime: "audio/m4a" })).rejects.toMatchObject({ code: "audio_too_long" });
    expect(requests).toHaveLength(0);
  });

  it("SPEECH_PROVIDER=azure 且有密钥和区域才开通", () => {
    expect(createSpeechScorer(testConfig())).toBeNull();
    expect(createSpeechScorer(testConfig({ speech: { provider: "azure", azureKey: "k" } }))).toBeNull();
    expect(createSpeechScorer(testConfig({ speech: { provider: "none", azureKey: "k", azureRegion: "eastasia" } }))).toBeNull();
    expect(createSpeechScorer(testConfig({ speech: { provider: "azure", azureKey: "k", azureRegion: "eastasia" } }))).not.toBeNull();
  });
});
