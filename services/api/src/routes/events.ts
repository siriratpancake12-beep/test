import type { FastifyInstance } from "fastify";
import { EventsReq, ROUTES } from "@lingo/core";
import type { Deps } from "../app";
import { optionalUser } from "../auth/session";

/**
 * 埋点上传(可选登录)。负责人:server-core。
 * - 按事件 id 去重:App 上传失败会重试,同一条事件不会算两次(同一批里重复的也只记一次)
 * - 登录了就记 user_id;凭证无效、过期或账号已注销的按没登录记(照收,不回 401,免得 App 一直重试)
 * - 记服务器收到的时间(客户端时间 at 照存,统计按 at 算:离线学的晚上传也算在学的那天)
 * - 不存 IP 等个人信息;props 的格式由 core 的 AppEvent 限制(只有短字符串、数字、布尔)
 * 返回这次新记下的条数(重复的不算)。
 */
export function registerEvents(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;

  app.post(ROUTES.events, async (req) => {
    const userId = await optionalUser(req, config);
    const { events } = EventsReq.parse(req.body, { error: () => "埋点数据格式不对" });
    const now = deps.now();
    const inserted = await db
      .insertInto("events")
      .values(
        events.map((e) => ({
          id: e.id,
          user_id: userId,
          anon_id: e.anonId,
          name: e.name,
          at: new Date(e.at),
          received_at: now,
          lang: e.lang ?? null,
          props: JSON.stringify(e.props),
          platform: e.platform,
          app_version: e.appVersion,
        })),
      )
      .onConflict((oc) => oc.column("id").doNothing())
      .returning("id")
      .execute();
    return { accepted: inserted.length };
  });
}
