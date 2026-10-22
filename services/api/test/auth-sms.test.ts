import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthResult, ROUTES, User } from "@lingo/core";
import { findOrCreateUser } from "../src/auth/users";
import { makeTestApp, type TestApp } from "./helpers";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 整个文件共用一个服务器(建一个 PGlite 要一两秒)。测试之间靠"各用各的一天、各用各的手机号和 IP"隔开:
 * 每个测试开始时把时钟拨到新的一天(和上一个测试差 10 天),限流和过期就互不影响。
 */
let t: TestApp;
let smsFails = false;
const codes = new Map<string, string>();
beforeAll(async () => {
  t = await makeTestApp({
    sms: {
      async send(phone, code) {
        if (smsFails) throw new Error("服务商出错");
        codes.set(phone, code);
      },
    },
  });
}, 60_000);
afterAll(async () => t?.app.close());

let day = 0;
beforeEach(() => {
  day += 10;
  smsFails = false;
  t.setNow(new Date(Date.parse("2026-11-01T12:00:00Z") + day * 86_400_000));
});
/** 这个测试专用的手机号 / IP */
const phone = (n = 0) => `139${String(day).padStart(4, "0")}${String(n).padStart(4, "0")}`;
const ip = (n = 0) => `203.0.${day % 250}.${n}`;
const later = (ms: number) => t.setNow(new Date(t.deps.now().getTime() + ms));
const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

const send = (p: string, remoteAddress = "198.51.100.1", headers: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: ROUTES.smsSend, payload: { phone: p }, headers, remoteAddress });
const verify = (p: string, code: string) => t.app.inject({ method: "POST", url: ROUTES.smsVerify, payload: { phone: p, code } });

describe("短信验证码登录", () => {
  it("发验证码 → 登录:第一次是新用户(id 是 UUID v4),再登录是同一个账号", async () => {
    const p = phone();
    const r = await send(p, ip());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(codes.get(p)).toMatch(/^\d{6}$/);

    const v = await verify(p, codes.get(p)!);
    expect(v.statusCode).toBe(200);
    const first = AuthResult.parse(v.json());
    expect(first.isNew).toBe(true);
    expect(first.user.id).toMatch(UUID_V4);
    expect(first.user).toMatchObject({ phone: p, hasApple: false, hasWechat: false, createdAt: t.deps.now().toISOString() });

    const me = await t.app.inject({ method: "GET", url: ROUTES.me, headers: { authorization: `Bearer ${first.token}` } });
    expect(me.statusCode).toBe(200);
    expect(User.parse(me.json())).toEqual(first.user);

    later(61_000);
    await send(p, ip());
    const second = AuthResult.parse((await verify(p, codes.get(p)!)).json());
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("数据库里只存验证码的哈希", async () => {
    const p = phone();
    await send(p, ip());
    const rows = await t.deps.db.selectFrom("sms_codes").selectAll().where("phone", "=", p).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(codes.get(p));
  });

  it("验证码 5 分钟有效", async () => {
    const p = phone();
    await send(p, ip());
    later(5 * 60_000 - 1000);
    const code = codes.get(p)!;
    // 快到期时还能用;过了 5 分钟就不行(用另一个号测,同一个码用过就失效了)
    expect((await verify(p, code)).statusCode).toBe(200);
    const q = phone(1);
    await send(q, ip());
    later(5 * 60_000 + 1000);
    const r = await verify(q, codes.get(q)!);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: "code_expired", message: "验证码已失效,请重新获取" });
  });

  it("验证错误最多 5 次,之后对的验证码也不行,要重新获取", async () => {
    const p = phone();
    await send(p, ip());
    const code = codes.get(p)!;
    for (let i = 1; i <= 4; i++) {
      const r = await verify(p, wrong(code));
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toEqual({ code: "code_wrong", message: `验证码不对,还可以再试 ${5 - i} 次` });
    }
    expect((await verify(p, wrong(code))).json().error).toEqual({ code: "code_locked", message: "验证码错误次数太多,请重新获取" });
    const right = await verify(p, code);
    expect(right.statusCode).toBe(400);
    expect(right.json().error.code).toBe("code_locked");

    later(61_000);
    await send(p, ip());
    expect((await verify(p, codes.get(p)!)).statusCode).toBe(200);
  });

  it("第 5 次才输对也能登录", async () => {
    const p = phone();
    await send(p, ip());
    const code = codes.get(p)!;
    for (let i = 0; i < 4; i++) await verify(p, wrong(code));
    expect((await verify(p, code)).statusCode).toBe(200);
  });

  it("同时发很多个猜测,也只有 5 次机会", async () => {
    const p = phone();
    await send(p, ip());
    const code = codes.get(p)!;
    const guesses = Array.from({ length: 12 }, (_, i) => String(i).padStart(6, "7")).filter((g) => g !== code);
    const rs = await Promise.all(guesses.map((g) => verify(p, g)));
    expect(rs.filter((r) => r.json().error.code === "code_locked")).toHaveLength(guesses.length - 4);
    const row = await t.deps.db.selectFrom("sms_codes").select("attempts").where("phone", "=", p).executeTakeFirstOrThrow();
    expect(row.attempts).toBe(5);
  });

  it("一个验证码只能用一次;以最后一次发送的为准", async () => {
    const p = phone();
    await send(p, ip());
    const first = codes.get(p)!;
    later(61_000);
    await send(p, ip());
    const second = codes.get(p)!;
    if (first !== second) expect((await verify(p, first)).statusCode).toBe(400);
    expect((await verify(p, second)).statusCode).toBe(200);
    const again = await verify(p, second);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe("code_expired");
  });

  it("两个请求同时拿着对的验证码来,只有一个成功", async () => {
    const p = phone();
    await send(p, ip());
    const code = codes.get(p)!;
    const rs = await Promise.all([verify(p, code), verify(p, code)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  it("同一个新手机号同时登录两次,只注册一个账号", async () => {
    const p = phone();
    // 绕过"验证码只能用一次",直接测并发注册
    const now = t.deps.now();
    const [a, b] = await Promise.all([findOrCreateUser(t.deps.db, { phone: p }, "phone", now), findOrCreateUser(t.deps.db, { phone: p }, "phone", now)]);
    expect(a.user.id).toBe(b.user.id);
    expect([a.isNew, b.isNew].sort()).toEqual([false, true]);
  });

  it("格式不对时给中文提示", async () => {
    const bad = await send("12345");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe("请输入正确的手机号");
    expect((await verify(phone(), "12ab")).json().error.message).toBe("请输入 6 位数字验证码");
    const noBody = await t.app.inject({ method: "POST", url: ROUTES.smsVerify });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().error.message).toBe("请输入正确的手机号");
    // 没发过验证码就来验证
    expect((await verify(phone(9), "123456")).json().error.code).toBe("code_expired");
  });

  it("短信发送失败:返回 502,不占次数,马上可以重试", async () => {
    const p = phone();
    smsFails = true;
    const r = await send(p, ip());
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toEqual({ code: "sms_failed", message: "短信发送失败,请稍后再试" });
    expect(await t.deps.db.selectFrom("sms_codes").selectAll().where("phone", "=", p).execute()).toHaveLength(0);
    smsFails = false;
    expect((await send(p, ip())).statusCode).toBe(200);
  });
});

describe("短信限流", () => {
  it("同一手机号 60 秒 1 次", async () => {
    const p = phone();
    expect((await send(p, ip())).statusCode).toBe(200);
    later(30_000);
    const r = await send(p, ip());
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toEqual({ code: "too_many_requests", message: "发送太频繁,请 30 秒后再试" });
    later(30_000);
    expect((await send(p, ip())).statusCode).toBe(200);
  });

  it("同一手机号每天 10 次(北京时间的自然日),第二天恢复", async () => {
    const p = phone();
    // 北京时间早上 8 点(UTC 0 点)开始
    t.setNow(new Date(`${t.deps.now().toISOString().slice(0, 10)}T00:00:00Z`));
    const today = t.deps.now().getTime();
    for (let i = 0; i < 10; i++) {
      expect((await send(p, ip(i))).statusCode).toBe(200);
      later(61_000);
    }
    const r = await send(p, ip(10));
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toBe("今天获取验证码的次数太多了,请明天再试");
    // 北京时间第二天 0 点前一秒还不行,0 点就可以
    t.setNow(new Date(today + 16 * 3_600_000 - 1000));
    expect((await send(p, ip(11))).statusCode).toBe(429);
    t.setNow(new Date(today + 16 * 3_600_000));
    expect((await send(p, ip(12))).statusCode).toBe(200);
  });

  it("同一 IP 每小时 20 次,换个 IP 或过一小时就可以", async () => {
    for (let i = 0; i < 20; i++) expect((await send(phone(i), ip())).statusCode).toBe(200);
    const r = await send(phone(20), ip());
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toBe("获取验证码太频繁,请一小时后再试");
    expect((await send(phone(20), ip(1))).statusCode).toBe(200);
    later(3_600_000);
    expect((await send(phone(21), ip())).statusCode).toBe(200);
  });

  it("在负载均衡后面时按 X-Forwarded-For 里的真实 IP 限流;公网直连时伪造的 X-Forwarded-For 不算数", async () => {
    const lb = "100.64.0.9";
    // 负载均衡(内网地址)转发来的:20 个不同手机号都来自同一个真实 IP
    for (let i = 0; i < 20; i++) await send(phone(i), lb, { "x-forwarded-for": ip(1) });
    expect((await send(phone(20), lb, { "x-forwarded-for": ip(1) })).statusCode).toBe(429);
    // 别的用户经过同一个负载均衡,不受影响
    expect((await send(phone(21), lb, { "x-forwarded-for": ip(2) })).statusCode).toBe(200);
    // 公网直连还想靠伪造请求头绕过:按连接地址算
    for (let i = 30; i < 50; i++) await send(phone(i), ip(3), { "x-forwarded-for": `10.0.0.${i}` });
    expect((await send(phone(50), ip(3), { "x-forwarded-for": ip(4) })).statusCode).toBe(429);
  });

  it("发送记录两天后清理(手机号和 IP 是个人信息,不多留)", async () => {
    await send(phone(0), ip());
    later(2 * 86_400_000 + 1000);
    await send(phone(1), ip());
    const left = await t.deps.db.selectFrom("sms_codes").select("phone").where("phone", "in", [phone(0), phone(1)]).execute();
    expect(left.map((r) => r.phone)).toEqual([phone(1)]);
  });
});
