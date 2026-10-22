import type { FastifyInstance } from "fastify";
import type { Deps } from "../app";
import type { Config } from "../config";

/** AI 口语老师(场景对话)。负责人:server-ai。 */
export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }
export interface LlmClient {
  /** 返回模型的文字回答;json=true 时要求模型只输出 JSON */
  chat(messages: LlmMessage[], opts?: { json?: boolean; maxTokens?: number; temperature?: number }): Promise<string>;
}

export function createLlmClient(_config: Config): LlmClient | null {
  return null;
}

export function registerTutor(_app: FastifyInstance, _deps: Deps) {}
