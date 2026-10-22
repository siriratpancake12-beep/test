import { describe, expect, it } from "vitest";
import { createOpenAiCompatClient, LlmError } from "../src/ai/openai-compat";
import { testConfig } from "../src/config";
import { createLlmClient } from "../src/routes/tutor";

/** 假的 fetch:记下请求,按顺序返回预设的响应(不访问外网) */
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("没有预设的响应");
    return next();
  }) as typeof fetch;
  return { f, requests };
}
const completion = (content: unknown) => () => Response.json({ id: "x", choices: [{ index: 0, message: { role: "assistant", content } }] });
const msgs = [{ role: "system" as const, content: "只输出 JSON" }, { role: "user" as const, content: "Hallo" }];

describe("OpenAI 兼容的大模型接口", () => {
  it("请求格式:地址、密钥、模型、JSON 模式、长度和温度", async () => {
    const { f, requests } = fakeFetch([completion('{"text":"Hallo!"}')]);
    const llm = createOpenAiCompatClient({ baseUrl: "https://api.example.cn/v1/", apiKey: "sk-test", model: "fast-chat", fetch: f });
    expect(await llm.chat(msgs, { json: true, maxTokens: 300, temperature: 0.5 })).toBe('{"text":"Hallo!"}');
    const r = requests[0]!;
    expect(r.url).toBe("https://api.example.cn/v1/chat/completions");
    expect(r.init.method).toBe("POST");
    expect((r.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(r.body).toEqual({ model: "fast-chat", messages: msgs, stream: false, temperature: 0.5, max_tokens: 300, response_format: { type: "json_object" } });
  });

  it("地址已经带了 /chat/completions 也可以;不要 JSON 时不发 response_format", async () => {
    const { f, requests } = fakeFetch([completion("Hallo!")]);
    const llm = createOpenAiCompatClient({ baseUrl: "https://ark.example.com/api/v3/chat/completions", apiKey: "k", model: "m", fetch: f });
    await llm.chat(msgs);
    expect(requests[0]!.url).toBe("https://ark.example.com/api/v3/chat/completions");
    expect(requests[0]!.body.response_format).toBeUndefined();
  });

  it("出错时区分能不能重试:限流、服务器错误能,密钥错不能", async () => {
    const statusError = async (status: number) => {
      const { f } = fakeFetch([() => new Response("oops", { status })]);
      const llm = createOpenAiCompatClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: f });
      return llm.chat(msgs).then(() => null, (e: unknown) => e as LlmError);
    };
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [401, false], [403, false]] as const) {
      const e = await statusError(status);
      expect(e).toBeInstanceOf(LlmError);
      expect(e!.status).toBe(status);
      expect(e!.retryable).toBe(retryable);
    }
  });

  it("模型不支持 response_format:去掉它重试,之后也不再发", async () => {
    const { f, requests } = fakeFetch([
      () => new Response('{"error":{"message":"response_format is not supported by this model"}}', { status: 400 }),
      completion('{"text":"a"}'),
      completion('{"text":"b"}'),
    ]);
    const llm = createOpenAiCompatClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: f });
    expect(await llm.chat(msgs, { json: true })).toBe('{"text":"a"}');
    expect(await llm.chat(msgs, { json: true })).toBe('{"text":"b"}');
    expect(requests.map((r) => "response_format" in r.body)).toEqual([true, false, false]);
  });

  it("空回答、网络错误、超时", async () => {
    const empty = createOpenAiCompatClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: fakeFetch([completion("  ")]).f });
    await expect(empty.chat(msgs)).rejects.toMatchObject({ retryable: true });

    const down = createOpenAiCompatClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(down.chat(msgs)).rejects.toMatchObject({ status: null, retryable: true });

    // 一直不回应的服务:到点中断,而且不建议马上重试(学习者等不起两次超时)
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const slow = createOpenAiCompatClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: hang, timeoutMs: 50 });
    await expect(slow.chat(msgs)).rejects.toMatchObject({ status: null, retryable: false });
  });

  it("三个环境变量缺一个就不开通", () => {
    const ai = { dailyFree: 3, dailyPremium: 60 };
    expect(createLlmClient(testConfig())).toBeNull();
    expect(createLlmClient(testConfig({ ai: { ...ai, baseUrl: "https://x/v1", apiKey: "k" } }))).toBeNull();
    expect(createLlmClient(testConfig({ ai: { ...ai, baseUrl: "https://x/v1", apiKey: "k", model: "m" } }))).not.toBeNull();
  });
});
