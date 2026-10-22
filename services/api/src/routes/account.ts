import type { FastifyInstance } from "fastify";
import { ROUTES, type User } from "@lingo/core";
import type { Deps } from "../app";
import { unauthorized } from "../errors";
import { requireUser } from "../auth/session";
import { toUser } from "../auth/users";

/**
 * 账号:查看自己的账号信息、注销账号。负责人:server-core。
 *
 * 注销(苹果审核 5.1.1(v) 和《个人信息保护法》都要求 App 内能注销):
 * - 删除个人信息:手机号、苹果/微信标识清空(这一行只留 id 和时间,用来让旧 token 失效、统计注册数)
 * - 删除学习进度、这个手机号的验证码记录(含 IP)
 * - 埋点保留(用于统计),但 user_id 置空,和这个人不再关联
 * - 之后这个账号不能再登录;同一个手机号、苹果账号、微信可以重新注册成一个新账号
 * 订阅记录由支付模块管理,不在这里删(交易记录要留着对账、处理退款)。
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
    await db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("users").select("phone").where("id", "=", userId).forUpdate().executeTakeFirst();
      await trx
        .updateTable("users")
        .set({ phone: null, apple_sub: null, wechat_unionid: null, wechat_openid: null, deleted_at: now })
        .where("id", "=", userId)
        .execute();
      await trx.deleteFrom("progress").where("user_id", "=", userId).execute();
      await trx.updateTable("events").set({ user_id: null }).where("user_id", "=", userId).execute();
      if (row?.phone) await trx.deleteFrom("sms_codes").where("phone", "=", row.phone).execute();
    });
    req.log.info({ userId }, "账号已注销");
    return reply.status(204).send();
  });
}
