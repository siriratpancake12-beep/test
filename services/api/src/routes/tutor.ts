import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { z } from "zod";
import { ROUTES, TutorChatReq, TutorChatRes, type Scenario, type TutorReply } from "@lingo/core";
import { buildTutorPrompt, parseTutorReply, screenUserText } from "@lingo/core/src/tutor";
import type { Deps } from "../app";
import { loadAiContent } from "../ai/content";
import { createOpenAiCompatClient, LlmError } from "../ai/openai-compat";
import { requireUser } from "../auth/session";
import type { Config } from "../config";
import { releaseQuota, takeQuota, utcDay } from "../db/ai";
import { badRequest, HttpError } from "../errors";
import { getPremium } from "./billing";

/** AI 口语老师(场景对话)。负责人:server-ai。 */
export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }
export interface LlmClient {
  /** 返回模型的文字回答;json=true 时要求模型只输出 JSON */
  chat(messages: LlmMessage[], opts?: { json?: boolean; maxTokens?: number; temperature?: number }): Promise<string>;
}

/** 三个环境变量(AI_BASE_URL / AI_API_KEY / AI_MODEL)缺一个就不开通,接口返回"暂未开通"。 */
export function createLlmClient(config: Config): LlmClient | null {
  const { baseUrl, apiKey, model } = config.ai;
  if (!baseUrl || !apiKey || !model) return null;
  return createOpenAiCompatClient({ baseUrl, apiKey, model });
}

type Reply = z.infer<typeof TutorReply>;
type Message = z.infer<typeof TutorChatReq>["messages"][number];

/** 第一次输出格式不对时,重试那次在系统提示末尾加的提醒(加在系统提示里:有的服务商不接受对话中间的 system 消息) */
const RETRY_HINT = "\n\n注意:上一次的输出不是合格的 JSON。这次只输出一个 JSON 对象,包含 text、zh、corrections、done 四个字段,不要任何其他文字。";

export function registerTutor(app: FastifyInstance, deps: Deps) {
  // 启动时读取并校验场景文件,有错就启动失败
  const { scenarios, packs } = loadAiContent();

  app.post(ROUTES.tutorChat, async (req) => {
    const userId = await requireUser(req, deps.config);
    const llm = deps.llm;
    if (!llm) throw new HttpError(503, "tutor_unavailable", "AI 老师暂未开通");
    const parsed = TutorChatReq.safeParse(req.body);
    if (!parsed.success) throw badRequest("请求格式不对,请更新 App 后再试", "invalid");
    const body = parsed.data;
    const scenario = scenarios.get(body.scenarioId);
    const pack = packs.get(body.lang);
    if (!scenario || scenario.lang !== body.lang || !pack) throw new HttpError(404, "scenario_not_found", "找不到这个口语场景,请更新 App 后再试");
    if (body.messages[body.messages.length - 1]!.role !== "user") throw badRequest("最后一句应该是你说的话", "invalid");

    // 个人信息不发给模型:拦下的话不调用模型,也不算次数。App 不要把被拦下的那句放进之后的历史里
    for (const m of body.messages) {
      if (m.role !== "user") continue;
      const s = screenUserText(m.text);
      if (!s.ok) throw new HttpError(400, s.kind === "crisis" ? "crisis" : "personal_info", s.messageZh);
    }

    const premium = await getPremium(deps, userId);
    const limit = premium ? deps.config.ai.dailyPremium : deps.config.ai.dailyFree;
    const day = utcDay(deps.now());
    const used = await takeQuota(deps.db, userId, day, "tutor", limit);
    if (used === null) {
      const vip = deps.config.ai.dailyPremium;
      throw new HttpError(
        429,
        "quota_exceeded",
        premium
          ? "今天和 AI 老师的练习次数用完了,明天再来吧"
          : limit > 0
            ? `今天的免费练习次数(${limit} 句)用完了,明天再来吧;会员每天可以练 ${vip} 句`
            : `AI 老师是会员功能,会员每天可以练 ${vip} 句`,
      );
    }

    const system = buildTutorPrompt(scenario, { level: body.level, knownWords: body.knownWords, pack });
    const reply = await askTutor(llm, system, chatHistory(scenario, body.messages), req.log);
    if (!reply) {
      // 失败不算次数(重试多花的钱算我们的)
      await releaseQuota(deps.db, userId, day, "tutor");
      throw new HttpError(502, "tutor_failed", "AI 老师暂时没有回应,请稍后再试");
    }
    return TutorChatRes.parse({ reply, remainingToday: Math.max(0, limit - used) });
  });
}

/**
 * App 发来的对话 → 模型的消息。App 可以不带开场白(服务器补上);相邻的同一方的话合并成一条,
 * 有的服务商要求用户和模型的消息交替出现。
 */
function chatHistory(scenario: Scenario, messages: Message[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const push = (role: "user" | "assistant", content: string) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.content += `\n${content}`;
    else out.push({ role, content });
  };
  if (messages[0]?.role !== "tutor") push("assistant", scenario.opening.text);
  for (const m of messages) push(m.role === "tutor" ? "assistant" : "user", m.text);
  return out;
}

/** 调用模型;输出不合格(或者调用出错)就重试一次,还不行返回 null。 */
async function askTutor(llm: LlmClient, system: string, history: LlmMessage[], log: FastifyBaseLogger): Promise<Reply | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retry = attempt > 1;
    try {
      const raw = await llm.chat([{ role: "system", content: retry ? system + RETRY_HINT : system }, ...history], {
        json: true,
        maxTokens: 500,
        temperature: retry ? 0.3 : 0.7,
      });
      const reply = parseTutorReply(raw);
      if (reply) return reply;
      // 不记录模型输出的内容:里面可能引用学习者的原话,我们承诺不保存对话
      log.warn({ attempt, length: raw.length }, "AI 老师的输出不是合格的 JSON");
    } catch (e) {
      log.warn({ attempt, err: (e as Error).message }, "调用大模型失败");
      if (e instanceof LlmError && !e.retryable) return null;
    }
  }
  return null;
}
