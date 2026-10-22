import type { LlmClient, LlmMessage } from "../routes/tutor";

/**
 * OpenAI 兼容的 chat completions 接口。国内主流大模型服务都支持这种接口,换服务商只改三个环境变量:
 *   AI_BASE_URL  填到 /chat/completions 之前的部分,例如
 *                DeepSeek            https://api.deepseek.com
 *                通义千问(阿里云百炼)https://dashscope.aliyuncs.com/compatible-mode/v1
 *                Kimi(月之暗面)      https://api.moonshot.cn/v1
 *                智谱                  https://open.bigmodel.cn/api/paas/v4
 *                豆包(火山方舟)      https://ark.cn-beijing.volces.com/api/v3
 *   AI_API_KEY   密钥(只放服务器环境变量)
 *   AI_MODEL     模型名(选非推理/非"深度思考"的快速模型:回答快、便宜,口语陪练不需要长推理)
 */
export class LlmError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码;网络错误、超时时为 null */
    public status: number | null,
    /** 马上重试有没有意义:限流和服务器错误有,密钥错、超时没有(超时再等一遍,学习者等不起) */
    public retryable: boolean,
  ) {
    super(message);
  }
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 测试时传入假的 fetch */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createOpenAiCompatClient(o: OpenAiCompatOptions): LlmClient {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.trim().replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const timeoutMs = o.timeoutMs ?? 20_000;
  // 个别模型不支持 response_format:第一次被拒后记住,之后不再发(提示词里也要求只输出 JSON,照样能解析)
  let jsonMode = true;

  async function call(messages: LlmMessage[], opts: { json?: boolean; maxTokens?: number; temperature?: number }, json: boolean): Promise<string> {
    const body: Record<string, unknown> = {
      model: o.model,
      messages,
      stream: false,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 500,
    };
    if (json) body.response_format = { type: "json_object" };
    // 超时覆盖整个请求(包括读响应体),到点就中断
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const fail = (e: unknown) =>
      ctrl.signal.aborted
        ? new LlmError(`大模型接口超时(${timeoutMs}ms)`, null, false)
        : new LlmError(`大模型接口连不上:${(e as Error).message}`, null, true);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      }).catch((e) => {
        throw fail(e);
      });
      const text = await res.text().catch((e) => {
        throw fail(e);
      });
      if (!res.ok) throw new LlmError(`大模型接口 HTTP ${res.status}:${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500);
      let content: unknown;
      try {
        content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
      } catch {
        content = undefined;
      }
      if (typeof content !== "string" || !content.trim()) throw new LlmError("大模型没有返回内容", res.status, true);
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async chat(messages, opts = {}) {
      const json = !!opts.json && jsonMode;
      try {
        return await call(messages, opts, json);
      } catch (e) {
        if (json && e instanceof LlmError && e.status === 400 && /response_format|json/i.test(e.message)) {
          jsonMode = false;
          return call(messages, opts, false);
        }
        throw e;
      }
    },
  };
}
