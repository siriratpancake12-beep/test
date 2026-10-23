import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { AppleLoginReq, ROUTES, SmsSendReq, SmsVerifyReq, WechatLoginReq, type AuthResult } from "@lingo/core";
import type { Deps } from "../app";
import type { Config } from "../config";
import type { Database } from "../db";
import { HttpError, badRequest, tooMany } from "../errors";
import { createAliyunSmsNotifier, createAliyunSmsSender } from "../auth/aliyun-sms";
import { AppleUnavailableError, createAppleIdVerifier } from "../auth/apple";
import { createAppleTokenClient } from "../auth/apple-tokens";
import { installAccountCheck, signSession } from "../auth/session";
import { SMS_RULES, beijingDayStart, hashSmsCode, newSmsCode, sameHash } from "../auth/sms-code";
import { findOrCreateUser, findUserBy, toUser, type UserRow } from "../auth/users";
import { WechatError, createWechatClient } from "../auth/wechat";

/**
 * 登录:手机号 + 短信验证码、Sign in with Apple、微信。负责人:server-core。
 * 下面几个接口是外部服务的抽象,测试里用假的实现;真实实现按 config 创建(createAuthProviders)。
 */
export interface SmsSender {
  send(phone: string, code: string): Promise<void>;
}
/** 通知短信(扣费前提醒):模板 CODE 和模板变量由调用方给;签名、AccessKey 和验证码短信共用 */
export interface SmsNotifier {
  notify(phone: string, templateCode: string, params: Record<string, string>): Promise<void>;
}
export interface AppleIdVerifier {
  /** 校验 App 拿到的 identityToken(苹果签名的 JWT),返回苹果用户 id */
  verify(identityToken: string): Promise<{ sub: string; email?: string }>;
}
export interface AppleTokenClient {
  /** 用 App 登录时拿到的一次性授权码换刷新令牌;sub 是令牌对应的苹果用户 id(核对授权码是不是本人的) */
  exchangeCode(code: string): Promise<{ refreshToken: string; sub?: string }>;
  /** 撤销授权(注销账号时,苹果要求) */
  revoke(refreshToken: string): Promise<void>;
}
export interface WechatClient {
  /** 用 App 拿到的 code 换微信用户身份 */
  exchange(code: string): Promise<{ openid: string; unionid?: string }>;
}

/** Apple 登录时最多等多久"用授权码换刷新令牌"(超过就让它在后台完成,先回登录结果) */
const APPLE_EXCHANGE_WAIT_MS = 2500;

/** 开发用:验证码打在日志里。生产环境 loadConfig 不允许用它。 */
const devSms: SmsSender = { async send(phone, code) { console.log(`[开发短信] ${phone} 验证码 ${code}`); } };

export function createAuthProviders(config: Config): { sms: SmsSender; apple: AppleIdVerifier | null; appleTokens: AppleTokenClient | null; wechat: WechatClient | null } {
  return {
    sms: createSmsSender(config),
    // 校验只需要苹果公开的公钥和我们的 bundleId,不需要密钥,所以总是开着
    apple: createAppleIdVerifier(config.apple.bundleId),
    appleTokens: createAppleTokens(config),
    wechat: config.wechat.appId && config.wechat.appSecret ? createWechatClient(config.wechat.appId, config.wechat.appSecret) : null,
  };
}

/** 配了 Sign in with Apple 的密钥(Team ID、Key ID、私钥)才开;没配时 Apple 登录照常,只是注销时没法向苹果撤销授权 */
export function createAppleTokens(config: Config): AppleTokenClient | null {
  const { teamId, signInKeyId, signInPrivateKey, bundleId } = config.apple;
  if (teamId && signInKeyId && signInPrivateKey) return createAppleTokenClient({ teamId, keyId: signInKeyId, privateKey: signInPrivateKey, clientId: bundleId });
  if (config.env !== "test") console.warn("[登录] 没有配置 Sign in with Apple 密钥(APPLE_TEAM_ID、APPLE_SIGNIN_KEY_ID、APPLE_SIGNIN_PRIVATE_KEY):注销账号时无法向苹果撤销授权");
  return null;
}

/** SMS_PROVIDER=aliyun 但配置不全时直接启动失败:比悄悄退回"验证码打日志"安全(那样线上谁都登录不了,验证码还进了日志) */
export function createSmsSender(config: Config): SmsSender {
  if (config.sms.provider !== "aliyun") return devSms;
  const { aliyunAccessKeyId, aliyunAccessKeySecret, signName, templateCode } = config.sms;
  const missing = Object.entries({ ALIYUN_ACCESS_KEY_ID: aliyunAccessKeyId, ALIYUN_ACCESS_KEY_SECRET: aliyunAccessKeySecret, SMS_SIGN_NAME: signName, SMS_TEMPLATE_CODE: templateCode })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`SMS_PROVIDER=aliyun 时必须设置 ${missing.join("、")}`);
  return createAliyunSmsSender({ accessKeyId: aliyunAccessKeyId!, accessKeySecret: aliyunAccessKeySecret!, signName: signName!, templateCode: templateCode! });
}

/** 开发用:通知短信也打在日志里(生产环境不允许 SMS_PROVIDER=dev) */
const devNotifier: SmsNotifier = {
  async notify(phone, templateCode, params) { console.log(`[开发短信] ${phone} 模板 ${templateCode} ${JSON.stringify(params)}`); },
};

/** 通知短信用验证码短信的 AccessKey 和签名;配置齐不齐由 createSmsSender 在启动时检查 */
export function createSmsNotifier(config: Config): SmsNotifier {
  if (config.sms.provider !== "aliyun") return devNotifier;
  createSmsSender(config);
  const { aliyunAccessKeyId, aliyunAccessKeySecret, signName } = config.sms;
  return createAliyunSmsNotifier({ accessKeyId: aliyunAccessKeyId!, accessKeySecret: aliyunAccessKeySecret!, signName: signName! });
}

/** 从某个时间起发了几条。op 为 ">=" 时含这一刻(自然日从 0 点算起),">" 时不含(滑动窗口:正好一小时前的那条已经不算) */
async function countSms(db: Kysely<Database>, col: "phone" | "ip", value: string, op: ">=" | ">", since: Date): Promise<number> {
  const r = await db
    .selectFrom("sms_codes")
    .select((eb) => eb.fn.countAll().as("n"))
    .where(col, "=", value)
    .where("created_at", op, since)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

export function registerAuth(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;

  // 注销后旧 token 立即作废(requireUser 会调用它)
  installAccountCheck(app, async (userId) => {
    const row = await db.selectFrom("users").select("deleted_at").where("id", "=", userId).executeTakeFirst();
    return !!row?.deleted_at;
  });

  const done = async (user: UserRow, isNew: boolean): Promise<AuthResult> => ({ token: await signSession(user.id, config), user: toUser(user), isNew });

  app.post(ROUTES.smsSend, async (req) => {
    const { phone } = SmsSendReq.parse(req.body, { error: () => "请输入正确的手机号" });
    // 负载均衡后面的真实 IP 由 Fastify 按 trustProxy 从 X-Forwarded-For 取(见 config.trustProxy)
    const ip = req.ip || "unknown";
    const now = deps.now();
    // 审核专用手机号:验证码固定、不发短信;除此以外(只存哈希、5 分钟有效、错 5 次作废、限流)和普通手机号走同一套
    const review = config.review?.phone === phone ? config.review : null;
    const code = review ? review.code : newSmsCode();
    const perDay = review ? SMS_RULES.reviewPhonePerDay : SMS_RULES.phonePerDay;
    const id = randomUUID();
    await db.transaction().execute(async (trx) => {
      // 同一手机号的请求排队检查,两个请求同时来也不会都通过"60 秒一次"
      await sql`select pg_advisory_xact_lock(hashtext(${`sms:${phone}`}))`.execute(trx);
      const last = await trx.selectFrom("sms_codes").select("created_at").where("phone", "=", phone).orderBy("created_at", "desc").limit(1).executeTakeFirst();
      if (last) {
        const wait = SMS_RULES.phoneCooldownMs - (now.getTime() - new Date(last.created_at).getTime());
        if (wait > 0) throw tooMany(`发送太频繁,请 ${Math.ceil(wait / 1000)} 秒后再试`);
      }
      if ((await countSms(trx, "phone", phone, ">=", beijingDayStart(now))) >= perDay) {
        throw tooMany("今天获取验证码的次数太多了,请明天再试");
      }
      if ((await countSms(trx, "ip", ip, ">", new Date(now.getTime() - 3_600_000))) >= SMS_RULES.ipPerHour) {
        throw tooMany("获取验证码太频繁,请一小时后再试");
      }
      await trx.deleteFrom("sms_codes").where("created_at", "<", new Date(now.getTime() - SMS_RULES.keepMs)).execute();
      await trx
        .insertInto("sms_codes")
        .values({
          id, phone, ip,
          code_hash: hashSmsCode(config.jwtSecret, phone, code),
          created_at: now,
          expires_at: new Date(now.getTime() + SMS_RULES.ttlMs),
          attempts: 0,
          used_at: null,
        })
        .execute();
    });
    if (review) {
      // 日志里不记手机号和验证码
      req.log.info("审核账号获取验证码:不发短信,用固定验证码");
      return { ok: true };
    }
    // 发短信是网络调用,放在事务外面,不占着数据库连接等短信服务商
    try {
      await deps.sms.send(phone, code);
    } catch (err) {
      // 没发出去就不算次数,也不留一个收不到的验证码,用户可以马上重试
      await db.deleteFrom("sms_codes").where("id", "=", id).execute();
      req.log.error({ err }, "短信发送失败");
      throw new HttpError(502, "sms_failed", "短信发送失败,请稍后再试");
    }
    return { ok: true };
  });

  app.post(ROUTES.smsVerify, async (req) => {
    const { phone, code } = SmsVerifyReq.parse(req.body, { error: (iss) => (iss.path?.[0] === "code" ? "请输入 6 位数字验证码" : "请输入正确的手机号") });
    const now = deps.now();
    // 以最后一次发送的验证码为准
    const row = await db.selectFrom("sms_codes").selectAll().where("phone", "=", phone).orderBy("created_at", "desc").limit(1).executeTakeFirst();
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= now.getTime()) throw badRequest("验证码已失效,请重新获取", "code_expired");
    // 先占用一次机会再比对:同时发很多个猜测也超不过次数上限
    const tried = await db
      .updateTable("sms_codes")
      .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
      .where("id", "=", row.id)
      .where("attempts", "<", SMS_RULES.maxAttempts)
      .where("used_at", "is", null)
      .returning("attempts")
      .executeTakeFirst();
    if (!tried) throw badRequest("验证码错误次数太多,请重新获取", "code_locked");
    if (!sameHash(hashSmsCode(config.jwtSecret, phone, code), row.code_hash)) {
      const left = SMS_RULES.maxAttempts - tried.attempts;
      throw badRequest(left > 0 ? `验证码不对,还可以再试 ${left} 次` : "验证码错误次数太多,请重新获取", left > 0 ? "code_wrong" : "code_locked");
    }
    // 一个验证码只能用一次(两个请求同时拿着对的码来,只有一个成功)
    const used = await db.updateTable("sms_codes").set({ used_at: now }).where("id", "=", row.id).where("used_at", "is", null).returning("id").executeTakeFirst();
    if (!used) throw badRequest("验证码已失效,请重新获取", "code_expired");
    const { user, isNew } = await findOrCreateUser(db, { phone }, "phone", now);
    return done(user, isNew);
  });

  app.post(ROUTES.appleLogin, async (req) => {
    if (!deps.apple) throw badRequest("暂不支持 Apple 登录", "login_unavailable");
    const { identityToken, authorizationCode } = AppleLoginReq.parse(req.body, { error: () => "Apple 登录信息不完整,请重试" });
    let sub: string;
    try {
      ({ sub } = await deps.apple.verify(identityToken));
    } catch (err) {
      if (err instanceof AppleUnavailableError) {
        req.log.warn({ err }, "连不上 Apple");
        throw new HttpError(503, "apple_unavailable", "暂时连不上 Apple,请稍后再试");
      }
      throw new HttpError(401, "apple_invalid", "Apple 登录验证失败,请重试");
    }
    const { user, isNew } = await findOrCreateUser(db, { apple_sub: sub }, "apple_sub", deps.now());
    if (authorizationCode && deps.appleTokens) {
      // 换刷新令牌存起来,注销账号时用它向苹果撤销授权。失败不影响这次登录(下次登录会再换);
      // 苹果慢的时候最多等一会儿,剩下的在后台做完,不拖慢登录
      const tokens = deps.appleTokens;
      const saving = (async () => {
        try {
          const got = await tokens.exchangeCode(authorizationCode);
          // 授权码必须是这个苹果账号自己的:别人的授权码存到这个账号上,注销时会撤销掉别人的授权
          if (got.sub && got.sub !== sub) {
            req.log.warn({ userId: user.id }, "授权码和登录的苹果账号不一致,不保存");
            return;
          }
          const saved = await db.updateTable("users").set({ apple_refresh_token: got.refreshToken })
            .where("id", "=", user.id).where("deleted_at", "is", null).executeTakeFirst();
          // 换到令牌之前账号已经注销了(苹果慢、用户很快注销):不存,直接撤销,和注销时的处理一样
          if (!Number(saved.numUpdatedRows)) {
            await tokens.revoke(got.refreshToken).catch((err: unknown) => req.log.error({ err, userId: user.id }, "向苹果撤销授权失败"));
          }
        } catch (err) {
          req.log.warn({ err, userId: user.id }, "用授权码换苹果刷新令牌失败(不影响登录)");
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([saving, new Promise<void>((r) => (timer = setTimeout(r, APPLE_EXCHANGE_WAIT_MS)))]);
      clearTimeout(timer);
    }
    return done(user, isNew);
  });

  app.post(ROUTES.wechatLogin, async (req) => {
    if (!deps.wechat) throw badRequest("暂不支持微信登录", "login_unavailable");
    const { code } = WechatLoginReq.parse(req.body, { error: () => "微信登录信息不完整,请重试" });
    let wx: { openid: string; unionid?: string };
    try {
      wx = await deps.wechat.exchange(code);
    } catch (err) {
      if (err instanceof WechatError && err.invalidCode) throw new HttpError(401, "wechat_invalid", "微信授权已失效,请重新登录");
      req.log.warn({ err }, "微信登录失败");
      throw new HttpError(502, "wechat_unavailable", "微信登录暂时不可用,请稍后再试");
    }
    // 有 unionid 优先按它认人(以后的小程序、网站同一个人也是同一个账号);以前只记了 openid 的也要认得
    const found = (wx.unionid ? await findUserBy(db, "wechat_unionid", wx.unionid) : undefined) ?? (await findUserBy(db, "wechat_openid", wx.openid));
    if (found) {
      if ((wx.unionid && !found.wechat_unionid) || !found.wechat_openid) {
        // 补上以前没拿到的标识;万一和别的账号冲突就算了,不影响这次登录
        await db
          .updateTable("users")
          .set({ wechat_unionid: found.wechat_unionid ?? wx.unionid ?? null, wechat_openid: found.wechat_openid ?? wx.openid })
          .where("id", "=", found.id)
          .execute()
          .catch((err) => req.log.warn({ err }, "补充微信标识失败"));
      }
      return done(found, false);
    }
    const { user, isNew } = await findOrCreateUser(db, { wechat_unionid: wx.unionid, wechat_openid: wx.openid }, wx.unionid ? "wechat_unionid" : "wechat_openid", deps.now());
    return done(user, isNew);
  });
}
