import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config";
import { HttpError, forbidden, unauthorized } from "../errors";

/**
 * 登录凭证:HS256 签名的 JWT,有效期 90 天。App 存在系统安全存储里。
 * (负责人 server-core 可以加"注销后作废"等,但这几个函数的签名不要改:billing、tutor 等模块都在用。)
 *
 * 注销后作废:JWT 本身撤不回,所以 requireUser 校验签名后还要问一句"这个账号注销了没有"。
 * 这个检查由 registerAuth 通过 installAccountCheck 装到 app 上(要查数据库,而这几个函数拿不到 db);
 * 没装的话(单独测试某个模块时)只校验签名。
 */
const TTL = "90d";
const key = (config: Config) => new TextEncoder().encode(config.jwtSecret);

declare module "fastify" {
  interface FastifyInstance {
    /** 账号是否已注销。见 installAccountCheck */
    accountDeleted?: (userId: string) => Promise<boolean>;
  }
}

/** 装上"账号是否已注销"的检查。用 decorate 而不是模块变量:每个 app(每个测试)各用各的数据库,子插件也能继承。 */
export function installAccountCheck(app: FastifyInstance, isDeleted: (userId: string) => Promise<boolean>): void {
  app.decorate("accountDeleted", isDeleted);
}

export async function signSession(userId: string, config: Config): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime(TTL).sign(key(config));
}

/** 从 Authorization: Bearer <token> 取出用户 id;没登录、过期或账号已注销就 401。 */
export async function requireUser(req: FastifyRequest, config: Config): Promise<string> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw unauthorized();
  let sub: string | undefined;
  try {
    ({ sub } = (await jwtVerify(h.slice(7), key(config), { algorithms: ["HS256"] })).payload);
  } catch {
    throw unauthorized("登录已过期,请重新登录");
  }
  if (!sub) throw unauthorized("登录已过期,请重新登录");
  if (await req.server.accountDeleted?.(sub)) throw unauthorized("账号已注销");
  return sub;
}

/**
 * 可选登录:token 有效就返回用户 id;没有 token、token 无效或过期、账号已注销都当作没登录,返回 null。
 * 埋点等接口登录前也能用;App 拿着过期的旧凭证上传埋点也照收(按匿名记),不会因为 401 一直重试。
 */
export async function optionalUser(req: FastifyRequest, config: Config): Promise<string | null> {
  if (!req.headers.authorization) return null;
  try {
    return await requireUser(req, config);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return null;
    throw e;
  }
}

/** 后台接口:请求头 x-admin-token 要和配置一致;没配置口令时后台关闭。 */
export function requireAdmin(req: FastifyRequest, config: Config): void {
  const got = req.headers["x-admin-token"];
  if (!config.adminToken || typeof got !== "string" || !sameSecret(got, config.adminToken)) throw forbidden();
}

/** 定长比较(先取哈希再比),不让响应时间泄露口令猜对了几位 */
function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
