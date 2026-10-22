import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { ROUTES, SpeechScoreRes, TutorChatRes } from "@lingo/core";
import { MAX_AUDIO_BYTES, pcmToWav } from "../src/ai/audio";
import { CONTENT_DIR, loadAiContent } from "../src/ai/content";
import { LlmError } from "../src/ai/openai-compat";
import { signSession } from "../src/auth/session";
import { HttpError } from "../src/errors";
import { SPEECH_DAILY_FREE, SPEECH_DAILY_PREMIUM, type SpeechScorer } from "../src/routes/speech";
import type { LlmClient, LlmMessage } from "../src/routes/tutor";
import { makeTestApp, type TestApp } from "./helpers";

/**
 * AI 老师和发音评测两个接口的完整流程。两者共用一个测试服务器:每个测试服务器都要启动一个内存数据库,
 * 启动很吃 CPU,并行的测试文件多了会把别的测试拖到超时。
 */

// 会员判断由 billing 模块负责;这里换成可控的假实现,只测额度逻辑
const premiumUsers = vi.hoisted(() => new Set<string>());
vi.mock("../src/routes/billing", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/routes/billing")>();
  return { ...mod, getPremium: async (_deps: unknown, userId: string) => premiumUsers.has(userId) };
});

const GOOD = JSON.stringify({
  text: "Gern! Für hier oder zum Mitnehmen?",
  zh: "好的!在这儿吃还是带走?",
  corrections: [{ original: "ein Kaffee", corrected: "einen Kaffee", explanationZh: "Kaffee 是阳性,宾格用 einen" }],
  done: false,
});

/** 假的大模型:按顺序返回预设的回答(或抛出错误),记下每次收到的消息 */
function fakeLlm() {
  const queue: (string | Error)[] = [];
  const calls: { messages: LlmMessage[]; opts?: { json?: boolean; maxTokens?: number; temperature?: number } }[] = [];
  const llm: LlmClient = {
    async chat(messages, opts) {
      calls.push({ messages, opts });
      const next = queue.shift() ?? GOOD;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { llm, queue, calls };
}

const RESULT = {
  score: 86,
  accuracy: 88,
  fluency: 90,
  completeness: 100,
  words: [{ word: "Guten", score: 92, error: "none" }, { word: "Tag", score: 70, error: "mispronunciation" }],
};

/** 假的发音评测:记下收到的录音和参数,可以让它抛错 */
function fakeScorer() {
  const calls: { audio: Buffer; opts: { text: string; locale: string; mime: string } }[] = [];
  const fail: Error[] = [];
  const speech: SpeechScorer = {
    async score(audio, opts) {
      calls.push({ audio, opts });
      const e = fail.shift();
      if (e) throw e;
      return RESULT;
    },
  };
  return { speech, calls, fail };
}

/** 16kHz 单声道 16 位的静音 WAV */
const wav = (seconds: number) => pcmToWav(Buffer.alloc(Math.round(seconds * 16000) * 2));
const M4A = Buffer.from("....ftypM4A fake m4a bytes");

const body = (over: Record<string, unknown> = {}) => ({
  lang: "de",
  scenarioId: "de.cafe_order",
  level: "A1",
  knownWords: ["Kaffee", "bitte"],
  messages: [{ role: "user", text: "Ich möchte ein Kaffee, bitte." }],
  ...over,
});

let t: TestApp;
let fake: ReturnType<typeof fakeLlm>;
let scorer: ReturnType<typeof fakeScorer>;
let userN = 0;
/** 每个测试用一个新用户,额度互不影响 */
async function newUser() {
  const id = `u_ai_${++userN}`;
  await t.deps.db.insertInto("users").values({ id } as never).execute();
  return { id, token: await signSession(id, t.deps.config) };
}
const chat = (token: string | null, payload: unknown) =>
  t.app.inject({ method: "POST", url: ROUTES.tutorChat, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as object });
const score = (token: string | null, audio: Buffer | string, contentType = "audio/m4a", query = "lang=de&text=Guten%20Tag") =>
  t.app.inject({
    method: "POST",
    url: `${ROUTES.speechScore}?${query}`,
    headers: { "content-type": contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: audio,
  });

/** 临时改一下依赖(不配服务、改额度)再恢复。接口每次请求时才读 deps,不用为每种配置各建一个测试服务器。 */
async function withDeps(change: () => void, run: () => Promise<void>) {
  const { llm, speech } = t.deps;
  const ai = { ...t.deps.config.ai };
  change();
  try {
    await run();
  } finally {
    Object.assign(t.deps, { llm, speech });
    t.deps.config.ai = ai;
  }
}

beforeAll(async () => {
  fake = fakeLlm();
  scorer = fakeScorer();
  t = await makeTestApp({ llm: fake.llm, speech: scorer.speech });
});
afterAll(async () => t?.app.close());

describe("AI 老师:完整流程", () => {
  it("没登录 → 401", async () => {
    expect((await chat(null, body())).statusCode).toBe(401);
  });

  it("返回老师的回答和今天剩余次数;提示和对话正确地交给模型", async () => {
    const { token } = await newUser();
    fake.calls.length = 0;
    const r = await chat(token, body());
    expect(r.statusCode).toBe(200);
    const res = TutorChatRes.parse(r.json());
    expect(res.reply.text).toBe("Gern! Für hier oder zum Mitnehmen?");
    expect(res.reply.corrections[0]?.corrected).toBe("einen Kaffee");
    expect(res.remainingToday).toBe(t.deps.config.ai.dailyFree - 1);

    expect(fake.calls).toHaveLength(1);
    const { messages, opts } = fake.calls[0]!;
    expect(opts?.json).toBe(true);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("咖啡馆店员");
    expect(messages[0]!.content).toContain("Kaffee | bitte");
    // App 没带开场白:服务器补上,模型知道自己已经说过什么
    expect(messages[1]).toEqual({ role: "assistant", content: "Hallo! Was möchten Sie trinken?" });
    expect(messages[2]).toEqual({ role: "user", content: "Ich möchte ein Kaffee, bitte." });
  });

  it("App 带了开场白就不重复补;老师的话交给模型时是 assistant", async () => {
    const { token } = await newUser();
    fake.calls.length = 0;
    const r = await chat(token, body({
      messages: [
        { role: "tutor", text: "Hallo! Was möchten Sie trinken?" },
        { role: "user", text: "Einen Kaffee, bitte." },
        { role: "tutor", text: "Gern! Für hier oder zum Mitnehmen?" },
        { role: "user", text: "Für hier." },
      ],
    }));
    expect(r.statusCode).toBe(200);
    expect(fake.calls[0]!.messages.map((m) => m.role)).toEqual(["system", "assistant", "user", "assistant", "user"]);
  });

  it("场景不存在、语种对不上 → 404", async () => {
    const { token } = await newUser();
    for (const over of [{ scenarioId: "de.nope" }, { lang: "fr" }, { lang: "en", scenarioId: "de.cafe_order" }]) {
      const r = await chat(token, body(over));
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("scenario_not_found");
      expect(r.json().error.message).toContain("找不到");
    }
  });

  it("请求格式不对 → 400(中文提示);最后一句不是学习者说的 → 400", async () => {
    const { token } = await newUser();
    const bad = await chat(token, body({ messages: [] }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/请求格式不对/);
    const last = await chat(token, body({ messages: [{ role: "user", text: "Hallo" }, { role: "tutor", text: "Hallo!" }] }));
    expect(last.statusCode).toBe(400);
  });

  it("没配置大模型 → 503 AI 老师暂未开通", async () => {
    const { token } = await newUser();
    await withDeps(
      () => (t.deps.llm = null),
      async () => {
        const r = await chat(token, body());
        expect(r.statusCode).toBe(503);
        expect(r.json().error).toEqual({ code: "tutor_unavailable", message: "AI 老师暂未开通" });
      },
    );
  });
});

describe("AI 老师:个人信息和安全", () => {
  it("手机号直接拦下:不调用模型、不算次数", async () => {
    const { token } = await newUser();
    fake.calls.length = 0;
    const r = await chat(token, body({ messages: [{ role: "user", text: "Meine Nummer ist 13800138000." }] }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("personal_info");
    expect(r.json().error.message).toContain("隐私");
    expect(fake.calls).toHaveLength(0);
    const ok = await chat(token, body());
    expect(ok.json().remainingToday).toBe(t.deps.config.ai.dailyFree - 1);
  });

  it("历史里的个人信息也不发给模型", async () => {
    const { token } = await newUser();
    fake.calls.length = 0;
    const r = await chat(token, body({ messages: [{ role: "user", text: "mail: lucy@example.com" }, { role: "tutor", text: "Danke!" }, { role: "user", text: "Bitte." }] }));
    expect(r.statusCode).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("危机表达给出求助信息", async () => {
    const { token } = await newUser();
    const r = await chat(token, body({ messages: [{ role: "user", text: "我不想活了" }] }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("crisis");
    expect(r.json().error.message).toContain("12356");
  });

  it("不保存对话内容,只记次数", async () => {
    const { id, token } = await newUser();
    const secret = "Zitronenkuchenparade";
    expect((await chat(token, body({ messages: [{ role: "user", text: `Ich möchte ${secret}.` }] }))).statusCode).toBe(200);
    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public'`.execute(t.deps.db);
    for (const { table_name } of tables.rows) {
      const rows = await sql`select * from ${sql.table(table_name)}`.execute(t.deps.db);
      expect(JSON.stringify(rows.rows), table_name).not.toContain(secret);
    }
    const usage = await t.deps.db.selectFrom("ai_usage").selectAll().where("user_id", "=", id).execute();
    expect(usage).toEqual([{ user_id: id, day: "2026-11-01", kind: "tutor", count: 1 }]);
  });
});

describe("AI 老师:模型输出不合格", () => {
  it("第一次不是 JSON → 重试一次(提醒只输出 JSON、温度调低)", async () => {
    const { token } = await newUser();
    fake.calls.length = 0;
    fake.queue.push("Gern! Für hier oder zum Mitnehmen?");
    const r = await chat(token, body());
    expect(r.statusCode).toBe(200);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.messages[0]!.content).toContain("上一次的输出不是合格的 JSON");
    expect(fake.calls[1]!.opts?.temperature).toBeLessThan(fake.calls[0]!.opts!.temperature!);
  });

  it("两次都不合格 → 502 中文提示,不算次数", async () => {
    const { token } = await newUser();
    fake.calls.length = 0;
    fake.queue.push("坏的", '{"text": "nur Text"}');
    const r = await chat(token, body());
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe("tutor_failed");
    expect(r.json().error.message).toContain("AI 老师暂时没有回应");
    expect(fake.calls).toHaveLength(2);
    const ok = await chat(token, body());
    expect(ok.json().remainingToday).toBe(t.deps.config.ai.dailyFree - 1);
  });

  it("调用出错也重试一次;密钥错这类不可重试的错误不重试", async () => {
    const { token } = await newUser();
    fake.calls.length = 0;
    fake.queue.push(new Error("网络抖动"));
    expect((await chat(token, body())).statusCode).toBe(200);
    expect(fake.calls).toHaveLength(2);

    fake.calls.length = 0;
    fake.queue.push(new LlmError("HTTP 401", 401, false));
    expect((await chat(token, body())).statusCode).toBe(502);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("AI 老师:每日额度", () => {
  it("免费用户每天 dailyFree 条,用完 429;按 UTC 日期,第二天恢复", async () => {
    const { token } = await newUser();
    const free = t.deps.config.ai.dailyFree;
    t.setNow(new Date("2026-11-03T23:58:00Z"));
    try {
      for (let i = 1; i <= free; i++) expect((await chat(token, body())).json().remainingToday).toBe(free - i);
      const over = await chat(token, body());
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe("quota_exceeded");
      expect(over.json().error.message).toContain("会员");
      t.setNow(new Date("2026-11-04T00:01:00Z"));
      expect((await chat(token, body())).json().remainingToday).toBe(free - 1);
    } finally {
      t.setNow(new Date("2026-11-01T12:00:00Z"));
    }
  });

  it("会员每天 dailyPremium 条", async () => {
    const { id, token } = await newUser();
    premiumUsers.add(id);
    expect((await chat(token, body())).json().remainingToday).toBe(t.deps.config.ai.dailyPremium - 1);
  });

  it("会员额度用完时不再推销会员;同时发的请求也不会超额", async () => {
    await withDeps(
      () => (t.deps.config.ai = { ...t.deps.config.ai, dailyFree: 2, dailyPremium: 3 }),
      async () => {
        const vip = await newUser();
        premiumUsers.add(vip.id);
        const all = await Promise.all(Array.from({ length: 5 }, () => chat(vip.token, body())));
        expect(all.filter((r) => r.statusCode === 200)).toHaveLength(3);
        const rejected = all.filter((r) => r.statusCode === 429);
        expect(rejected).toHaveLength(2);
        expect(rejected[0]!.json().error.message).not.toContain("会员每天");

        const free = await newUser();
        const results = await Promise.all(Array.from({ length: 4 }, () => chat(free.token, body())));
        expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2);
      },
    );
  });

  it("免费额度配成 0:AI 老师只给会员用", async () => {
    await withDeps(
      () => (t.deps.config.ai = { ...t.deps.config.ai, dailyFree: 0, dailyPremium: 60 }),
      async () => {
        const { token } = await newUser();
        const r = await chat(token, body());
        expect(r.statusCode).toBe(429);
        expect(r.json().error.message).toBe("AI 老师是会员功能,会员每天可以练 60 句");
      },
    );
  });
});

describe("口语场景文件", () => {
  it("仓库里的场景都能读出来", () => {
    const { scenarios } = loadAiContent();
    expect(scenarios.size).toBe(24);
    expect(scenarios.get("fr.train_ticket")?.lang).toBe("fr");
  });

  it("场景文件有错误时启动失败,并说清楚错在哪", () => {
    const dir = mkdtempSync(join(tmpdir(), "lingo-content-"));
    try {
      cpSync(join(CONTENT_DIR, "languages"), join(dir, "languages"), { recursive: true });
      cpSync(join(CONTENT_DIR, "scenarios"), join(dir, "scenarios"), { recursive: true });
      writeFileSync(join(dir, "scenarios", "es.json"), JSON.stringify([{ id: "es.bar", lang: "es", level: "A1" }]));
      writeFileSync(join(dir, "scenarios", "xx.json"), "[]");
      expect(() => loadAiContent(dir)).toThrow(/scenarios\/es\.json #1[\s\S]*xx\.json: 没有对应的语言包/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("发音评测:完整流程", () => {
  it("没登录 → 401", async () => {
    expect((await score(null, M4A)).statusCode).toBe(401);
  });

  it("原始音频 + query 参数 → 评测结果;语种换成语言包里的区域代码", async () => {
    const { token } = await newUser();
    scorer.calls.length = 0;
    const r = await score(token, M4A);
    expect(r.statusCode).toBe(200);
    expect(SpeechScoreRes.parse(r.json())).toEqual(RESULT);
    expect(scorer.calls).toHaveLength(1);
    expect(scorer.calls[0]!.opts).toEqual({ text: "Guten Tag", locale: "de-DE", mime: "audio/m4a" });
    expect(scorer.calls[0]!.audio.equals(M4A)).toBe(true);
  });

  it("content-type 的别名和参数都认", async () => {
    const { token } = await newUser();
    scorer.calls.length = 0;
    expect((await score(token, wav(1), "audio/x-wav")).statusCode).toBe(200);
    expect((await score(token, M4A, "audio/mp4; codecs=mp4a.40.2", "lang=fr&text=Bonjour")).statusCode).toBe(200);
    expect((await score(token, M4A, "audio/webm;codecs=opus", "lang=en&text=Hello")).statusCode).toBe(200);
    expect(scorer.calls.map((c) => [c.opts.mime, c.opts.locale])).toEqual([["audio/wav", "de-DE"], ["audio/mp4", "fr-FR"], ["audio/webm", "en-US"]]);
  });

  it("没配置发音评测 → 503 发音评测暂未开通", async () => {
    const { token } = await newUser();
    await withDeps(
      () => (t.deps.speech = null),
      async () => {
        const r = await score(token, M4A);
        expect(r.statusCode).toBe(503);
        expect(r.json().error).toEqual({ code: "speech_unavailable", message: "发音评测暂未开通" });
      },
    );
  });
});

describe("发音评测:请求检查", () => {
  it("不是音频 → 415(中文提示)", async () => {
    const { token } = await newUser();
    for (const ct of ["application/octet-stream", "application/json", "text/plain", "video/mp4"]) {
      const r = await score(token, ct === "application/json" ? JSON.stringify({ a: 1 }) : M4A, ct);
      expect(r.statusCode, ct).toBe(415);
      expect(r.json().error.code).toBe("unsupported_audio");
      expect(r.json().error.message).toContain("不支持这种录音格式");
    }
  });

  it("超过 2MB → 413(中文提示)", async () => {
    const { token } = await newUser();
    const r = await score(token, Buffer.alloc(MAX_AUDIO_BYTES + 1), "audio/aac");
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toEqual({ code: "audio_too_large", message: "录音文件太大了,最大 2MB" });
  });

  it("空录音、缺少 text、不认识的语种、text 太长 → 400", async () => {
    const { token } = await newUser();
    expect((await score(token, Buffer.alloc(0))).statusCode).toBe(400);
    for (const q of ["lang=de", "text=Hallo", "lang=xx&text=Hallo", "lang=de&text=%20%20", `lang=de&text=${"a".repeat(301)}`]) {
      const r = await score(token, M4A, "audio/m4a", q);
      expect(r.statusCode, q).toBe(400);
      expect(r.json().error.message).toMatch(/请求格式不对|没有收到录音/);
    }
  });

  it("WAV 超过 15 秒 → 400,不调用评测、不算次数", async () => {
    const { token } = await newUser();
    scorer.calls.length = 0;
    const r = await score(token, wav(16), "audio/wav");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: "audio_too_long", message: "录音太长了,最多 15 秒" });
    expect(scorer.calls).toHaveLength(0);
    // 刚好录满 15 秒的可以
    expect((await score(token, wav(15.2), "audio/wav")).statusCode).toBe(200);
  });

  it("原始音频解析只在发音评测上生效:别的接口不收音频、照常解析 JSON", async () => {
    const { token } = await newUser();
    const r = await t.app.inject({ method: "POST", url: ROUTES.tutorChat, headers: { "content-type": "audio/wav", authorization: `Bearer ${token}` }, payload: wav(1) });
    expect(r.statusCode).toBe(415);
    expect((await chat(token, body())).statusCode).toBe(200);
  });
});

describe("发音评测:额度和出错", () => {
  it(`免费用户每天 ${SPEECH_DAILY_FREE} 次,会员 ${SPEECH_DAILY_PREMIUM} 次`, async () => {
    const free = await newUser();
    for (let i = 0; i < SPEECH_DAILY_FREE; i++) expect((await score(free.token, M4A)).statusCode).toBe(200);
    const over = await score(free.token, M4A);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("quota_exceeded");
    expect(over.json().error.message).toContain("会员");

    const vip = await newUser();
    premiumUsers.add(vip.id);
    for (let i = 0; i <= SPEECH_DAILY_FREE; i++) expect((await score(vip.token, M4A)).statusCode).toBe(200);
  });

  it("录音的问题原样告诉用户;其他错误给通用提示;失败都不算次数", async () => {
    const { id, token } = await newUser();
    scorer.fail.push(new HttpError(422, "no_speech", "没听清,请靠近话筒、用正常的音量再读一遍"), new Error("Azure HTTP 401"));
    const a = await score(token, M4A);
    expect(a.statusCode).toBe(422);
    expect(a.json().error.code).toBe("no_speech");
    const b = await score(token, M4A);
    expect(b.statusCode).toBe(502);
    expect(b.json().error).toEqual({ code: "speech_failed", message: "发音评测暂时不可用,请稍后再试" });
    const usage = await t.deps.db.selectFrom("ai_usage").selectAll().where("user_id", "=", id).execute();
    expect(usage.map((u) => [u.kind, u.count])).toEqual([["speech", 0]]);
  });
});
