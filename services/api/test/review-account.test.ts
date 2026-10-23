import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthResult, ROUTES } from "@lingo/core";
import { loadConfig, parseReviewAccount, testConfig, weakCode } from "../src/config";
import { makeTestApp, type TestApp } from "./helpers";

/** 审核专用账号:App Store、安卓商店审核时用的手机号和固定验证码(见 config.review) */
const REVIEW = { phone: "13900007777", code: "730518" };

describe("审核账号的配置", () => {
  it("两个变量都配了才开,默认关闭;生产环境也能用", () => {
    expect(loadConfig({}).review).toBeNull();
    expect(loadConfig({ REVIEW_PHONE: REVIEW.phone, REVIEW_CODE: REVIEW.code }).review).toEqual(REVIEW);
    expect(loadConfig({ REVIEW_PHONE: ` ${REVIEW.phone} `, REVIEW_CODE: `${REVIEW.code}\n` }).review).toEqual(REVIEW);
    const prod = { NODE_ENV: "production", JWT_SECRET: "x".repeat(48), SMS_PROVIDER: "aliyun", DATABASE_URL: "postgres://app:pw@db.internal:5432/yutu" };
    expect(loadConfig({ ...prod, REVIEW_PHONE: REVIEW.phone, REVIEW_CODE: REVIEW.code }).review).toEqual(REVIEW);
  });

  it("只配了一个:不开,并在日志里提醒", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig({ REVIEW_PHONE: REVIEW.phone }).review).toBeNull();
    expect(loadConfig({ REVIEW_CODE: REVIEW.code }).review).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("REVIEW_PHONE 和 REVIEW_CODE 要一起配置"));
    warn.mockRestore();
  });

  it("手机号、验证码格式不对,或者验证码太好猜:启动就报错", () => {
    expect(() => parseReviewAccount("12345678901", REVIEW.code, "test")).toThrow("REVIEW_PHONE 必须是 11 位中国大陆手机号");
    expect(() => parseReviewAccount(REVIEW.phone, "12345", "test")).toThrow("REVIEW_CODE 必须是 6 位数字");
    expect(() => parseReviewAccount(REVIEW.phone, "73051a", "test")).toThrow("REVIEW_CODE 必须是 6 位数字");
    for (const c of ["000000", "888888", "012345", "123456", "567890", "654321", "098765", "543210"]) {
      expect(() => parseReviewAccount(REVIEW.phone, c, "test"), c).toThrow("太容易猜");
    }
    for (const c of ["730518", "135790", "112233", "024680"]) expect(weakCode(c), c).toBe(false);
  });
});

describe("审核账号登录", () => {
  let t: TestApp;
  /** 普通手机号收到的验证码(假短信) */
  const sms = new Map<string, string>();
  beforeAll(async () => {
    t = await makeTestApp({ config: testConfig({ review: REVIEW }), sms: { async send(phone, code) { sms.set(phone, code); } } });
  }, 60_000);
  afterAll(async () => t?.app.close());

  // 每个测试用新的一天(和 auth-sms.test.ts 一样),限流互不影响
  let day = 0;
  beforeEach(() => {
    day += 10;
    sms.clear();
    t.setNow(new Date(Date.parse("2026-11-01T12:00:00Z") + day * 86_400_000));
  });
  const later = (ms: number) => t.setNow(new Date(t.deps.now().getTime() + ms));
  const send = (phone: string, remoteAddress = "198.51.100.1") => t.app.inject({ method: "POST", url: ROUTES.smsSend, payload: { phone }, remoteAddress });
  const verify = (phone: string, code: string) => t.app.inject({ method: "POST", url: ROUTES.smsVerify, payload: { phone, code } });

  it("获取验证码不发短信;输入固定验证码登录,第一次是新账号,再登录是同一个账号", async () => {
    const r = await send(REVIEW.phone);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(sms.size).toBe(0);
    // 和普通验证码一样只存哈希
    const rows = await t.deps.db.selectFrom("sms_codes").select("code_hash").where("phone", "=", REVIEW.phone).execute();
    expect(JSON.stringify(rows)).not.toContain(REVIEW.code);

    const first = AuthResult.parse((await verify(REVIEW.phone, REVIEW.code)).json());
    expect(first.isNew).toBe(true);
    expect(first.user.phone).toBe(REVIEW.phone);

    later(61_000);
    await send(REVIEW.phone);
    const second = AuthResult.parse((await verify(REVIEW.phone, REVIEW.code)).json());
    expect(second).toMatchObject({ isNew: false, user: { id: first.user.id } });
  });

  it("其他规则和普通手机号一样:要先点获取验证码,用过就作废,错 5 次作废", async () => {
    // 没点"获取验证码"直接登录
    expect((await verify(REVIEW.phone, REVIEW.code)).json().error.code).toBe("code_expired");
    await send(REVIEW.phone);
    expect((await verify(REVIEW.phone, REVIEW.code)).statusCode).toBe(200);
    expect((await verify(REVIEW.phone, REVIEW.code)).json().error.code).toBe("code_expired");

    later(61_000);
    await send(REVIEW.phone);
    for (let i = 0; i < 4; i++) expect((await verify(REVIEW.phone, "111111")).json().error.code).toBe("code_wrong");
    expect((await verify(REVIEW.phone, "111111")).json().error.code).toBe("code_locked");
    expect((await verify(REVIEW.phone, REVIEW.code)).json().error.code).toBe("code_locked");

    // 5 分钟有效
    later(61_000);
    await send(REVIEW.phone);
    later(5 * 60_000 + 1000);
    expect((await verify(REVIEW.phone, REVIEW.code)).json().error.code).toBe("code_expired");
  });

  it("只对审核手机号生效:别的手机号照常发短信,固定验证码对它们没用", async () => {
    const other = "13900008888";
    await send(other);
    expect(sms.get(other)).toMatch(/^\d{6}$/);
    const code = sms.get(other)!;
    if (code !== REVIEW.code) expect((await verify(other, REVIEW.code)).json().error.code).toBe("code_wrong");
    expect((await verify(other, code)).statusCode).toBe(200);
  });

  it("同一手机号 60 秒一次照样限;每天可以获取 50 次(普通手机号 10 次)", async () => {
    // 北京时间早上 8 点(UTC 0 点)开始,一天里发完
    t.setNow(new Date(`${t.deps.now().toISOString().slice(0, 10)}T00:00:00Z`));
    expect((await send(REVIEW.phone)).statusCode).toBe(200);
    expect((await send(REVIEW.phone)).statusCode).toBe(429);
    for (let i = 1; i < 50; i++) {
      later(61_000);
      // 换着 IP 发,免得先碰上"同一 IP 每小时 20 次"
      expect((await send(REVIEW.phone, `203.0.113.${i}`)).statusCode, `第 ${i + 1} 次`).toBe(200);
    }
    later(61_000);
    const r = await send(REVIEW.phone, "203.0.113.200");
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toBe("今天获取验证码的次数太多了,请明天再试");
  });

  it("审核员注销账号以后,同一个手机号还能再登录(新账号)", async () => {
    await send(REVIEW.phone);
    const me = AuthResult.parse((await verify(REVIEW.phone, REVIEW.code)).json());
    const del = await t.app.inject({ method: "DELETE", url: ROUTES.account, headers: { authorization: `Bearer ${me.token}` } });
    expect(del.statusCode).toBe(204);
    later(61_000);
    await send(REVIEW.phone);
    const again = AuthResult.parse((await verify(REVIEW.phone, REVIEW.code)).json());
    expect(again.isNew).toBe(true);
    expect(again.user.id).not.toBe(me.user.id);
  });

  it("没开审核账号的服务器:这个手机号就是普通手机号", async () => {
    const plain = await makeTestApp({ db: t.deps.db, sms: { async send(phone, code) { sms.set(phone, code); } } });
    plain.setNow(t.deps.now());
    await plain.app.inject({ method: "POST", url: ROUTES.smsSend, payload: { phone: REVIEW.phone } });
    expect(sms.get(REVIEW.phone)).toMatch(/^\d{6}$/);
    await plain.app.close();
  });
});
