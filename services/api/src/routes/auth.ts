import type { FastifyInstance } from "fastify";
import type { Deps } from "../app";
import type { Config } from "../config";

/**
 * 登录:手机号 + 短信验证码、Sign in with Apple、微信。负责人:server-core。
 * 下面三个接口是外部服务的抽象,测试里用假的实现;真实实现按 config 创建(createAuthProviders)。
 */
export interface SmsSender {
  send(phone: string, code: string): Promise<void>;
}
export interface AppleIdVerifier {
  /** 校验 App 拿到的 identityToken(苹果签名的 JWT),返回苹果用户 id */
  verify(identityToken: string): Promise<{ sub: string; email?: string }>;
}
export interface WechatClient {
  /** 用 App 拿到的 code 换微信用户身份 */
  exchange(code: string): Promise<{ openid: string; unionid?: string }>;
}

export function createAuthProviders(_config: Config): { sms: SmsSender; apple: AppleIdVerifier | null; wechat: WechatClient | null } {
  return {
    sms: { async send(phone, code) { console.log(`[开发短信] ${phone} 验证码 ${code}`); } },
    apple: null,
    wechat: null,
  };
}

export function registerAuth(_app: FastifyInstance, _deps: Deps) {}
