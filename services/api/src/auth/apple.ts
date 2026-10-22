import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AppleIdVerifier } from "../routes/auth";

/**
 * Sign in with Apple:App 拿到的 identityToken 是苹果用私钥签名的 JWT,用苹果公开的公钥(JWKS)校验:
 * 签名对、签发方是苹果、受众是我们的 bundleId、没过期,才信里面的 sub(苹果用户 id,同一个 App 下不变)。
 * 公钥由 jose 缓存,苹果换钥匙时(token 里的 kid 找不到)会自动重新下载。
 */
export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

/** 连不上苹果(下载公钥超时、网络错误、苹果返回错误):不是用户的错,接口返回 503 让他稍后再试 */
export class AppleUnavailableError extends Error {}

/** 这些错误说明 token 本身不对(伪造、过期、不是给我们 App 的、格式坏了),是"登录失败";其他错误按"连不上苹果"处理 */
const BAD_TOKEN = new Set([
  "ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWT_INVALID", "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "ERR_JWKS_NO_MATCHING_KEY", "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JOSE_NOT_SUPPORTED",
]);

/** jwks 默认从苹果下载(带缓存);测试时传本机的假 JWKS 地址或本地公钥 */
export function createAppleIdVerifier(bundleId: string, jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(APPLE_JWKS_URL), { timeoutDuration: 5000 })): AppleIdVerifier {
  return {
    async verify(identityToken) {
      try {
        const { payload } = await jwtVerify(identityToken, jwks, { issuer: APPLE_ISSUER, audience: bundleId, algorithms: ["RS256"] });
        if (!payload.sub) throw new errors.JWTClaimValidationFailed("缺少 sub", payload, "sub", "missing");
        return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
      } catch (e) {
        if (e instanceof errors.JOSEError && BAD_TOKEN.has(e.code)) throw e;
        throw new AppleUnavailableError(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
