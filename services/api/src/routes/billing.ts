import type { FastifyInstance } from "fastify";
import type { AppStoreVerifier } from "@lingo/billing";
import type { Deps } from "../app";
import type { Config } from "../config";

/** 订阅:查询会员状态、App 上报交易、App Store 服务器通知。负责人:billing。 */
export function createAppStoreVerifier(_config: Config): AppStoreVerifier | null {
  return null;
}

/**
 * 这个用户现在是不是会员(AI 老师、发音评测等模块用来判断额度)。签名不要改。
 */
export async function getPremium(_deps: Deps, _userId: string): Promise<boolean> {
  return false;
}

export function registerBilling(_app: FastifyInstance, _deps: Deps) {}
