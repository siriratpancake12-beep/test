import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import { LangCode, ROUTES, SpeechScoreRes } from "@lingo/core";
import type { Deps } from "../app";
import { AUDIO_TYPES, checkDuration, MAX_AUDIO_BYTES, normalizeAudioMime, parseWav } from "../ai/audio";
import { createAzureScorer } from "../ai/azure-speech";
import { loadAiContent } from "../ai/content";
import { requireUser } from "../auth/session";
import type { Config } from "../config";
import { releaseQuota, takeQuota, utcDay } from "../db/ai";
import { badRequest, HttpError } from "../errors";
import { getPremium } from "./billing";

/** 发音评测。负责人:server-ai。 */
export interface SpeechScorer {
  score(audio: Buffer, opts: { text: string; locale: string; mime: string }): Promise<SpeechScoreRes>;
}

/**
 * 每天的评测次数。免费 10 次够跟读一节课的重点句;会员 200 次够每天认真练两三节课,
 * 同时给成本封顶(Azure 按录音时长计费,估算见 docs/09-AI老师与语音.md)。
 */
export const SPEECH_DAILY_FREE = 10;
export const SPEECH_DAILY_PREMIUM = 200;
/** 参考文本(要读的句子)最长多少字:15 秒读不完更长的句子 */
const MAX_TEXT = 300;

const SpeechQuery = z.object({ lang: LangCode, text: z.string().trim().min(1).max(MAX_TEXT) });

/** SPEECH_PROVIDER=azure 且配了密钥和区域才开通;否则接口返回"暂未开通",App 退回到"自己听、自己对比"。 */
export function createSpeechScorer(config: Config): SpeechScorer | null {
  const { provider, azureKey, azureRegion } = config.speech;
  if (provider !== "azure" || !azureKey || !azureRegion) return null;
  return createAzureScorer({ key: azureKey, region: azureRegion });
}

export function registerSpeech(app: FastifyInstance, deps: Deps) {
  const { packs } = loadAiContent();

  // 单独的插件作用域:音频的原始请求体解析和下面的错误处理只对这个接口生效,其他接口的 JSON 解析不受影响
  app.register(async (scope) => {
    scope.addContentTypeParser(AUDIO_TYPES, { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES }, (_req, body, done) => done(null, body));
    // Fastify 自己的"太大"、"格式不支持"错误是英文的:换成中文,再交给全局的错误处理统一格式
    scope.setErrorHandler((err: FastifyError) => {
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") throw new HttpError(413, "audio_too_large", "录音文件太大了,最大 2MB");
      if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") throw unsupported();
      throw err;
    });
    // 先查登录和是否开通,再收录音:没登录的请求不用先把 2MB 收下来
    const users = new WeakMap<object, string>();
    scope.addHook("onRequest", async (req) => {
      users.set(req, await requireUser(req, deps.config));
      if (!deps.speech) throw new HttpError(503, "speech_unavailable", "发音评测暂未开通");
    });

    scope.post(ROUTES.speechScore, async (req) => {
      const userId = users.get(req)!;
      const scorer = deps.speech!;
      const mime = normalizeAudioMime(req.headers["content-type"]);
      if (!mime || !Buffer.isBuffer(req.body)) throw unsupported();
      const audio = req.body;
      if (audio.length === 0) throw badRequest("没有收到录音,请重新录一次", "audio_empty");
      const q = SpeechQuery.safeParse(req.query);
      if (!q.success) throw badRequest("请求格式不对,请更新 App 后再试", "invalid");
      const pack = packs.get(q.data.lang);
      if (!pack) throw badRequest("暂时不支持这个语种的发音评测", "invalid");
      // WAV 能直接读出时长:超长的不占次数、不调用服务就拒绝。其他格式转换以后由评测服务检查
      if (mime === "audio/wav") {
        const info = parseWav(audio);
        if (info) checkDuration(info.durationSec);
      }

      const premium = await getPremium(deps, userId);
      const limit = premium ? SPEECH_DAILY_PREMIUM : SPEECH_DAILY_FREE;
      const day = utcDay(deps.now());
      const used = await takeQuota(deps.db, userId, day, "speech", limit);
      if (used === null) {
        throw new HttpError(
          429,
          "quota_exceeded",
          premium ? "今天的发音评测次数用完了,明天再来吧" : `今天的免费发音评测(${limit} 次)用完了,明天再来吧;会员每天可以评测 ${SPEECH_DAILY_PREMIUM} 次`,
        );
      }
      try {
        return SpeechScoreRes.parse(await scorer.score(audio, { text: q.data.text, locale: pack.locale, mime }));
      } catch (e) {
        // 失败不算次数;录音的问题(太长、没听清)直接告诉用户,其他问题记日志、给通用提示
        await releaseQuota(deps.db, userId, day, "speech");
        if (e instanceof HttpError && e.status < 500) {
          // ffmpeg 转不了的录音:报错信息留在日志里,方便查是哪种手机录的格式有问题
          if (e.cause) req.log.warn({ code: e.code, cause: e.cause, mime }, "录音无法处理");
          throw e;
        }
        // 服务端的问题(缺 ffmpeg、Azure 繁忙或配置错)要让运维看到
        req.log.error({ err: (e as Error).message, cause: (e as Error).cause }, "发音评测失败");
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, "speech_failed", "发音评测暂时不可用,请稍后再试");
      }
    });
  });
}

const unsupported = () => new HttpError(415, "unsupported_audio", "不支持这种录音格式,请用 wav、m4a、aac 或 webm");
