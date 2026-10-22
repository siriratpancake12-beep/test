import type { FastifyInstance } from "fastify";
import type { SpeechScoreRes } from "@lingo/core";
import type { Deps } from "../app";
import type { Config } from "../config";

/** 发音评测。负责人:server-ai。 */
export interface SpeechScorer {
  score(audio: Buffer, opts: { text: string; locale: string; mime: string }): Promise<SpeechScoreRes>;
}

export function createSpeechScorer(_config: Config): SpeechScorer | null {
  return null;
}

export function registerSpeech(_app: FastifyInstance, _deps: Deps) {}
