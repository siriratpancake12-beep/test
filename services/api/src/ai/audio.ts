import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../errors";

/**
 * 录音处理:识别格式、读 WAV 时长、用 ffmpeg 转成发音评测需要的 16kHz 单声道 16 位 WAV。
 * App 录的是 m4a(iOS / 安卓)或 webm(网页版),发音评测服务大多只收 PCM WAV,所以服务器要转一次。
 * 录音只在内存里处理;ffmpeg 需要文件时写到临时目录,用完马上删(个人信息保护:录音不落盘保存)。
 */

export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 15;
/** 录满 15 秒时编码器常会多出几十毫秒,留一点余量,免得刚好录满的被拒 */
const DURATION_SLACK = 0.5;
const MIN_AUDIO_SECONDS = 0.3;

/** 接受的录音类型(content-type,不含参数)。别名统一成左边的写法。 */
const MIME_ALIASES: Record<string, string> = {
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/m4a": "audio/m4a",
  "audio/x-m4a": "audio/m4a",
  "audio/mp4": "audio/mp4",
  "audio/aac": "audio/aac",
  "audio/x-aac": "audio/aac",
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mpeg": "audio/mpeg",
  "audio/3gpp": "audio/3gpp",
};
export const AUDIO_TYPES = Object.keys(MIME_ALIASES);

/** "audio/x-wav; codecs=1" → "audio/wav";不支持的类型返回 null */
export function normalizeAudioMime(contentType: string | undefined): string | null {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return MIME_ALIASES[base] ?? null;
}

export interface WavInfo {
  /** 1 = PCM,3 = 浮点,0xFFFE = 扩展格式 */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationSec: number;
}

/** 读 WAV 文件头。不是 WAV 或文件头坏了返回 null。 */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let fmt: Omit<WavInfo, "dataOffset" | "dataLength" | "durationSec"> | null = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt || !fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample) return null;
      // 边录边写的文件,头里的长度可能是 0 或 0xFFFFFFFF:以实际剩下的字节为准
      const dataLength = size === 0 || body + size > buf.length ? buf.length - body : size;
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return { ...fmt, dataOffset: body, dataLength, durationSec: dataLength / bytesPerSec };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

/** 已经是 16kHz、单声道、16 位 PCM,可以直接交给发音评测 */
export const isPcm16kMono = (w: WavInfo) => w.format === 1 && w.channels === 1 && w.sampleRate === 16000 && w.bitsPerSample === 16;

/** 给裸 PCM(16 位、单声道)加上 44 字节的 WAV 文件头 */
export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 录音太长、太短都不评测(太长费钱,也超出发音评测的单次上限)。 */
export function checkDuration(sec: number): void {
  if (sec > MAX_AUDIO_SECONDS + DURATION_SLACK) throw new HttpError(400, "audio_too_long", `录音太长了,最多 ${MAX_AUDIO_SECONDS} 秒`);
  if (sec < MIN_AUDIO_SECONDS) throw new HttpError(400, "audio_too_short", "录音太短了,请按住按钮把句子读完");
}

export interface FfmpegOptions {
  /** 默认用 PATH 里的 ffmpeg(生产 Docker 镜像会装) */
  ffmpegPath?: string;
  timeoutMs?: number;
}

/**
 * 用 ffmpeg 把任意录音转成 16kHz 单声道 16 位 WAV。
 * 输入写到临时文件而不是管道:iOS 录的 m4a 常把索引(moov)放在文件末尾,从管道读会失败。
 * 输出要裸 PCM 再自己加文件头:管道输出的 WAV 文件头里没有正确的长度。
 * 最多转 MAX_AUDIO_SECONDS + 1 秒,超长的录音不会占太多 CPU,转完再判断时长。
 */
export async function ffmpegToWav(audio: Buffer, o: FfmpegOptions = {}): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "lingo-audio-"));
  try {
    const input = join(dir, "in");
    await writeFile(input, audio, { mode: 0o600 });
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-t", String(MAX_AUDIO_SECONDS + 1), "-ac", "1", "-ar", "16000", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"];
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(o.ffmpegPath ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 10_000);
      p.stdout.on("data", (c: Buffer) => out.push(c));
      p.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-500)));
      p.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          e.code === "ENOENT"
            ? new HttpError(503, "ffmpeg_missing", "服务器缺少音频转换工具 ffmpeg,暂时只能评测 16kHz 单声道 WAV 录音")
            : e,
        );
      });
      p.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve(Buffer.concat(out));
        if (signal) return reject(new Error(`ffmpeg 超时被终止(${signal})`));
        // ffmpeg 的报错留给日志排查,不给用户看
        reject(Object.assign(new HttpError(400, "audio_invalid", "录音文件无法识别,请重新录一次"), { cause: err.trim() }));
      });
    });
    return pcmToWav(pcm);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 发音评测要的格式:已经是 16kHz 单声道 WAV 就直接用,其他格式(包括别的采样率的 WAV)用 ffmpeg 转。 */
export async function toPcm16kWav(audio: Buffer, mime: string, o: FfmpegOptions = {}): Promise<Buffer> {
  if (mime === "audio/wav") {
    const info = parseWav(audio);
    if (info && isPcm16kMono(info)) return audio;
  }
  return ffmpegToWav(audio, o);
}
