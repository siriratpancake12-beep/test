import type { FastifyInstance } from "fastify";
import { ROUTES, type User } from "@lingo/core";
import type { Deps } from "../app";
import { deleteAiUsage } from "../db/ai";
import { forgetBillingUser } from "../db/billing";
import { forgetRenewalSms } from "../db/jobs";
import { unauthorized } from "../errors";
import { requireUser } from "../auth/session";
import { toUser } from "../auth/users";

/**
 * 账号:查看自己的账号信息、注销账号。负责人:server-core。
 *
 * 注销(苹果审核 5.1.1(v) 和《个人信息保护法》都要求 App 内能注销):
 * - 用 Apple 登录过的,先向苹果撤销授权(苹果要求);撤销失败不挡注销,记日志
 * - 删除个人信息:手机号、苹果/微信标识和令牌清空(这一行只留 id 和时间,用来让旧 token 失效、统计注册数)
 * - 删除学习进度、这个手机号的验证码记录(含 IP)、AI 老师和发音评测的用量记录
 * - 订阅:删除订阅状态;交易流水保留(对账、退款、指标要用),但 user_id 置空,和这个人不再关联;
 *   订阅换绑记录里的这个 id 改成 "deleted"(见 db/billing.ts 的 forgetBillingUser)
 * - 埋点保留(用于统计),user_id 同样置空;扣费前短信的记录(提醒过的凭据)也一样
 * - 之后这个账号不能再登录;同一个手机号、苹果账号、微信可以重新注册成一个新账号
 * 注销不等于取消苹果订阅(订阅在用户的 Apple ID 下),App 里注销前会提示。
 * 注销那一刻正在进行的请求可能在注销之后又写进来,每天的清理任务会再扫一遍(jobs/retention.ts)。
 * 埋点、交易流水之后按《隐私政策》的保存期限删除(同上)。
 */
export function registerAccount(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;

  app.get(ROUTES.me, async (req): Promise<User> => {
    const userId = await requireUser(req, config);
    const row = await db.selectFrom("users").selectAll().where("id", "=", userId).where("deleted_at", "is", null).executeTakeFirst();
    if (!row) throw unauthorized("请重新登录");
    return toUser(row);
  });

  app.delete(ROUTES.account, async (req, reply) => {
    const userId = await requireUser(req, config);
    const now = deps.now();
    const row = await db.selectFrom("users").select(["phone", "apple_sub", "apple_refresh_token"]).where("id", "=", userId).executeTakeFirst();

    // 先撤销苹果授权(网络调用,不放在事务里);苹果那边出错也照样注销,不能让用户注销不了
    if (row?.apple_refresh_token) {
      if (deps.appleTokens) {
        try {
          await deps.appleTokens.revoke(row.apple_refresh_token);
        } catch (err) {
          req.log.error({ err, userId }, "向苹果撤销授权失败");
        }
      } else {
        req.log.warn({ userId }, "没有配置 Sign in with Apple 密钥,跳过向苹果撤销授权");
      }
    } else if (row?.apple_sub) {
      req.log.warn({ userId }, "没有苹果刷新令牌(登录时没带授权码或换取失败),无法向苹果撤销授权");
    }

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("users")
        .set({ phone: null, apple_sub: null, apple_refresh_token: null, wechat_unionid: null, wechat_openid: null, deleted_at: now })
        .where("id", "=", userId)
        .execute();
      await trx.deleteFrom("progress").where("user_id", "=", userId).execute();
      await trx.updateTable("events").set({ user_id: null }).where("user_id", "=", userId).execute();
      if (row?.phone) await trx.deleteFrom("sms_codes").where("phone", "=", row.phone).execute();
      await deleteAiUsage(trx, userId);
      await forgetBillingUser(trx, userId);
      await forgetRenewalSms(trx, userId);
    });
    req.log.info({ userId }, "账号已注销");
    return reply.status(204).send();
  });
}
