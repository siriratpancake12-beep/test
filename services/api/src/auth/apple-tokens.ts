import { SignJWT, decodeJwt, importPKCS8, type CryptoKey } from "jose";
import type { AppleTokenClient } from "../routes/auth";

/**
 * Sign in with Apple 的令牌接口:登录时用一次性授权码换刷新令牌,注销账号时撤销授权。
 * 苹果要求:支持 Apple 登录的 App,用户在 App 里注销账号时要调用撤销接口(App Store 审核指南 5.1.1(v))。
 *
 * 调用要带 client_secret:用 Sign in with Apple 的私钥(.p8,和内购的密钥不是同一把)签的 ES256 JWT,
 * iss = Team ID,sub = App 的 bundle id,aud = https://appleid.apple.com。苹果允许最长 6 个月,我们每次现签、5 分钟有效。
 * 刷新令牌单独拿到没有用(换令牌、撤销都要我们的私钥签的 client_secret),所以直接存在数据库里。
 */
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const AUDIENCE = "https://appleid.apple.com";

export interface AppleSignInKey {
  teamId: string;
  keyId: string;
  /** .p8 文件的内容(PEM);环境变量里把换行写成 \n 也可以 */
  privateKey: string;
  /** App 的 bundle id */
  clientId: string;
}

/** 苹果返回的错误,比如 invalid_grant(授权码过期或用过了)、invalid_client(密钥配错了) */
export class AppleTokenError extends Error {
  constructor(public status: number, public error: string) {
    super(`Sign in with Apple 接口出错:${status} ${error}`);
  }
}

/** 环境变量里的私钥:\n 换回换行;只给了中间那段 base64 时补上 PEM 头尾 */
export function normalizePem(key: string): string {
  const s = key.trim().replace(/\\n/g, "\n");
  return s.includes("-----BEGIN") ? s : `-----BEGIN PRIVATE KEY-----\n${s.replace(/\s+/g, "")}\n-----END PRIVATE KEY-----`;
}

export async function appleClientSecret(key: AppleSignInKey, privateKey: CryptoKey, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: key.keyId })
    .setIssuer(key.teamId)
    .setSubject(key.clientId)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(privateKey);
}

export function createAppleTokenClient(key: AppleSignInKey, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): AppleTokenClient {
  let imported: Promise<CryptoKey> | undefined;
  const secret = async () => appleClientSecret(key, await (imported ??= importPKCS8(normalizePem(key.privateKey), "ES256")), now());

  async function post(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // 网关错误等返回的不一定是 JSON
    }
    if (!res.ok) throw new AppleTokenError(res.status, typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
    return data;
  }

  return {
    async exchangeCode(code) {
      const data = await post(APPLE_TOKEN_URL, { client_id: key.clientId, client_secret: await secret(), code, grant_type: "authorization_code" });
      if (typeof data.refresh_token !== "string" || !data.refresh_token) throw new AppleTokenError(200, "no_refresh_token");
      // id_token 是苹果在这次(带我们密钥的)请求里直接返回的,不用再验签,只取 sub 核对是不是同一个人
      let sub: string | undefined;
      if (typeof data.id_token === "string") {
        try {
          sub = decodeJwt(data.id_token).sub;
        } catch {
          // 解不开就不核对
        }
      }
      return { refreshToken: data.refresh_token, sub };
    },
    async revoke(refreshToken) {
      await post(APPLE_REVOKE_URL, { client_id: key.clientId, client_secret: await secret(), token: refreshToken, token_type_hint: "refresh_token" });
    },
  };
}
