import { randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import type { User } from "@lingo/core";
import type { Db } from "../db";
import type { CoreTables } from "../db/core";

export type UserRow = Selectable<CoreTables["users"]>;

/** 能用来认人的字段(都有唯一约束;注销时清空,所以同一个手机号以后能注册成新账号) */
export type IdentityColumn = "phone" | "apple_sub" | "wechat_unionid" | "wechat_openid";

export const toUser = (u: UserRow): User => ({
  id: u.id,
  phone: u.phone,
  hasApple: !!u.apple_sub,
  hasWechat: !!(u.wechat_unionid || u.wechat_openid),
  createdAt: new Date(u.created_at).toISOString(),
});

export async function findUserBy(db: Db, col: IdentityColumn, value: string): Promise<UserRow | undefined> {
  return db.selectFrom("users").selectAll().where(col, "=", value).where("deleted_at", "is", null).executeTakeFirst();
}

/**
 * 按身份找用户,没有就注册一个。id 用 UUID v4(支付模块拿它当苹果内购的 appAccountToken)。
 * 同一个手机号同时点两次"登录"时两个请求会一起插入:靠唯一约束 + on conflict do nothing,
 * 插入失败的那个再查一次,两边拿到的是同一个账号。
 */
export async function findOrCreateUser(
  db: Db,
  identity: Partial<Record<IdentityColumn, string>>,
  lookup: IdentityColumn,
  now: Date,
): Promise<{ user: UserRow; isNew: boolean }> {
  const value = identity[lookup];
  if (!value) throw new Error(`缺少身份字段 ${lookup}`);
  const found = await findUserBy(db, lookup, value);
  if (found) return { user: found, isNew: false };
  const inserted = await db
    .insertInto("users")
    .values({
      id: randomUUID(),
      phone: identity.phone ?? null,
      apple_sub: identity.apple_sub ?? null,
      wechat_unionid: identity.wechat_unionid ?? null,
      wechat_openid: identity.wechat_openid ?? null,
      created_at: now,
      deleted_at: null,
    })
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { user: inserted, isNew: true };
  const again = await findUserBy(db, lookup, value);
  if (!again) throw new Error("注册账号失败:身份冲突");
  return { user: again, isNew: false };
}
