import type { FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config";
import { forbidden, unauthorized } from "../errors";

/**
 * 登录凭证:HS256 签名的 JWT,有效期 90 天。App 存在系统安全存储里。
 * (负责人 server-core 可以加"注销后作废"等,但这两个函数的签名不要改:billing、tutor 等模块都在用。)
 */
const TTL = "90d";
const key = (config: Config) => new TextEncoder().encode(config.jwtSecret);

export async function signSession(userId: string, config: Config): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime(TTL).sign(key(config));
}

/** 从 Authorization: Bearer <token> 取出用户 id;没登录或过期就 401。 */
export async function requireUser(req: FastifyRequest, config: Config): Promise<string> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw unauthorized();
  try {
    const { payload } = await jwtVerify(h.slice(7), key(config), { algorithms: ["HS256"] });
    if (!payload.sub) throw unauthorized();
    return payload.sub;
  } catch {
    throw unauthorized("登录已过期,请重新登录");
  }
}

/** 可选登录:有 token 就返回用户 id,没有返回 null(埋点等接口登录前也能用)。 */
export async function optionalUser(req: FastifyRequest, config: Config): Promise<string | null> {
  return req.headers.authorization ? requireUser(req, config) : null;
}

/** 后台接口:请求头 x-admin-token 要和配置一致;没配置口令时后台关闭。 */
export function requireAdmin(req: FastifyRequest, config: Config): void {
  if (!config.adminToken || req.headers["x-admin-token"] !== config.adminToken) throw forbidden();
}
