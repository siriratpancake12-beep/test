import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ROUTES, daysBetween, type MetricsRes } from "@lingo/core";
import type { Deps } from "../app";
import { notFound } from "../errors";
import { requireAdmin } from "../auth/session";
import { computeMetrics } from "../admin/metrics";
import { ADMIN_HEADERS, ADMIN_HTML } from "../admin/page";

/** 后台:指标接口(要后台口令)和指标页面。负责人:server-core。 */
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
  // 2026-02-30 这种格式对但不存在的日期也挡掉(格式不对时这里也会执行,不能让 toISOString 抛错)
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().startsWith(s);
  }, "日期不存在");

const MetricsQuery = z
  .object({ from: Day, to: Day })
  .refine((q) => q.from <= q.to, "开始日期不能晚于结束日期")
  // 范围太大的查询要扫很多埋点;更长的趋势分段查
  .refine((q) => daysBetween(q.from, q.to) < 366, "日期范围最多一年");

export function registerAdmin(app: FastifyInstance, deps: Deps) {
  app.get(ROUTES.adminMetrics, async (req): Promise<MetricsRes> => {
    requireAdmin(req, deps.config);
    const { from, to } = MetricsQuery.parse(req.query, { error: () => "请选择开始和结束日期(YYYY-MM-DD)" });
    return computeMetrics(deps.db, from, to, deps.now());
  });

  // 没配置后台口令时后台整个关闭,页面也不给
  app.get("/admin", async (_req, reply) => {
    if (!deps.config.adminToken) throw notFound();
    return reply.headers(ADMIN_HEADERS).send(ADMIN_HTML);
  });
}
