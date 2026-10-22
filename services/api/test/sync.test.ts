import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, completeLesson, emptyProgress, recordAnswer, type Lesson, type Progress } from "@lingo/core";
import { createUser, makeTestApp, type TestApp } from "./helpers";

let t: TestApp;
// 建 PGlite 要一两秒,几个测试文件并行时更慢,给足时间
beforeAll(async () => {
  t = await makeTestApp();
}, 60_000);
afterAll(async () => t?.app.close());

/** 合并只用到课的 id 和新词的 id */
const lesson = (id: string, words: string[]) => ({ id, newItems: words.map((w) => ({ id: w })) }) as unknown as Lesson;
const L1 = lesson("de.a1u1.l01", ["de.hallo", "de.tschuess"]);
const L2 = lesson("de.a1u1.l02", ["de.vater", "de.mutter"]);
const at = (day: string, h = 20) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00+08:00`);
/** 存到服务器再取回来的样子(日期变成字符串) */
const json = (p: unknown) => JSON.parse(JSON.stringify(p));

const phone = (): Progress => completeLesson(emptyProgress("de"), L1, at("2026-11-01"));
const tablet = (): Progress => ({ ...completeLesson(emptyProgress("de"), L2, at("2026-11-02")), goal: { kind: "travel", target: "A2", dailyMinutes: 20 } });

type Headers = { authorization: string };
const get = (h: Headers, lang = "de") => t.app.inject({ method: "GET", url: ROUTES.progress(lang), headers: h });
const put = (h: Headers, progress: unknown, baseRev: number, lang = "de") =>
  t.app.inject({ method: "PUT", url: ROUTES.progress(lang), headers: h, payload: { progress, baseRev } });

describe("进度同步", () => {
  it("要登录", async () => {
    expect((await t.app.inject({ method: "GET", url: ROUTES.progress("de") })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "PUT", url: ROUTES.progress("de"), payload: { progress: phone(), baseRev: 0 } })).statusCode).toBe(401);
  });

  it("还没上传过:progress 为 null,rev 为 0", async () => {
    const u = await createUser(t);
    const r = await get(u.headers);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ progress: null, rev: 0 });
  });

  it("第一次上传 rev 变成 1,取回来和上传的一样", async () => {
    const u = await createUser(t);
    const r = await put(u.headers, phone(), 0);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ progress: json(phone()), rev: 1 });
    expect((await get(u.headers)).json()).toEqual({ progress: json(phone()), rev: 1 });
  });

  it("baseRev 等于服务器的 rev:直接保存(只改了目标、没有新的学习记录也能保存下来)", async () => {
    const u = await createUser(t);
    await put(u.headers, phone(), 0);
    const changed = { ...phone(), goal: { kind: "exam", target: "B1", dailyMinutes: 30 } };
    const r = await put(u.headers, changed, 1);
    expect(r.json().rev).toBe(2);
    expect(r.json().progress.goal).toEqual(changed.goal);
  });

  it("baseRev 过期:和服务器上的那份合并,两台设备学的都在", async () => {
    const u = await createUser(t);
    expect((await put(u.headers, phone(), 0)).json().rev).toBe(1);
    // 平板不知道手机传过(baseRev 还是 0)
    const merged = (await put(u.headers, tablet(), 0)).json();
    expect(merged.rev).toBe(2);
    expect(Object.keys(merged.progress.completed).sort()).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
    expect(Object.keys(merged.progress.learned).sort()).toEqual(["de.hallo", "de.mutter", "de.tschuess", "de.vater"]);
    // 设置取最近学习的那台(平板)
    expect(merged.progress.goal.target).toBe("A2");

    // 手机离线又答了一题,拿着旧的 baseRev 1 上传:平板的课还在,新答的题也在
    const more = recordAnswer(phone(), { itemId: "de.hallo", direction: "produce", verdict: "correct" }, at("2026-11-03"));
    const third = (await put(u.headers, more, 1)).json();
    expect(third.rev).toBe(3);
    expect(Object.keys(third.progress.completed).sort()).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
    expect(third.progress.cards["de.hallo#produce"].card.reps).toBe(1);
    expect((await get(u.headers)).json()).toEqual(third);
  });

  it("两台设备同时第一次上传:排队处理,后到的那个合并,一条都不丢", async () => {
    const u = await createUser(t);
    const [a, b] = await Promise.all([put(u.headers, phone(), 0), put(u.headers, tablet(), 0)]);
    expect([a.json().rev, b.json().rev].sort()).toEqual([1, 2]);
    const final = (await get(u.headers)).json();
    expect(final.rev).toBe(2);
    expect(Object.keys(final.progress.completed).sort()).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
  });

  it("每个语种一份,每个人只能看到自己的", async () => {
    const u = await createUser(t);
    const other = await createUser(t);
    await put(u.headers, phone(), 0);
    const fr = { ...emptyProgress("fr"), skipped: ["fr.a1u1.l01"] };
    expect((await put(u.headers, fr, 0, "fr")).json().rev).toBe(1);
    expect((await get(u.headers, "de")).json().rev).toBe(1);
    expect((await get(u.headers, "fr")).json().progress.skipped).toEqual(["fr.a1u1.l01"]);
    expect((await get(other.headers, "de")).json()).toEqual({ progress: null, rev: 0 });
  });

  it("语种和地址不一致、语种格式不对:400", async () => {
    const u = await createUser(t);
    const r = await put(u.headers, emptyProgress("fr"), 0, "de");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: "lang_mismatch", message: "进度的语种和地址不一致" });
    expect((await get(u.headers, "not-a-language")).json().error.code).toBe("invalid_lang");
  });

  it("数据格式不对:400,不会存进去", async () => {
    const u = await createUser(t);
    for (const bad of [null, "text", [], { lang: "de", cards: null }, { lang: "de", log: { "not-a-day": {} } }, { lang: "de", cards: { x: { itemId: "x" } } }, { tz: 480 }]) {
      const r = await put(u.headers, bad, 0);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error.message).toBe("进度数据格式不对");
    }
    expect((await t.app.inject({ method: "PUT", url: ROUTES.progress("de"), headers: u.headers, payload: { progress: phone(), baseRev: -1 } })).statusCode).toBe(400);
    expect((await get(u.headers)).json()).toEqual({ progress: null, rev: 0 });
  });

  it("进度超过 1MB:413", async () => {
    const u = await createUser(t);
    const huge = { ...emptyProgress("de"), note: "x".repeat(1024 * 1024) };
    const r = await put(u.headers, huge, 0);
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toEqual({ code: "progress_too_large", message: "学习进度数据太大,暂时无法同步" });
  });

  it("第一版的进度格式会转换成新格式再保存", async () => {
    const u = await createUser(t);
    const r = await put(u.headers, { lang: "de", completedLessons: ["de.a1u1.l01"], activeDays: ["2026-10-30"] }, 0);
    expect(r.statusCode).toBe(200);
    const p = r.json().progress;
    expect(p.version).toBe(2);
    expect(p.completed).toEqual({ "de.a1u1.l01": "2026-10-30" });
    expect(p.log["2026-10-30"].answers).toBe(5);
    expect(p).not.toHaveProperty("completedLessons");
  });
});
