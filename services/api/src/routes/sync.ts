import type { FastifyInstance, FastifyRequest } from "fastify";
import { ProgressPutReq, ROUTES, mergeProgress, parseProgress, type Progress, type ProgressRes } from "@lingo/core";
import type { Deps } from "../app";
import { HttpError, badRequest } from "../errors";
import { requireUser } from "../auth/session";

/**
 * 进度同步。负责人:server-core。每个用户每个语种一行(Progress 的 JSON + rev)。
 *
 * PUT 带 baseRev(这台设备上次从服务器拿到的版本号):
 * - 等于服务器当前的 rev:说明这期间没有别的设备写过,直接保存这份
 *   (只有这样,"只改了目标、没有新的学习记录"这类修改才能原样保存,合并规则会按学习时间挑设置)
 * - 不等:别的设备写过,用 core 的 mergeProgress 合并两份再保存,一条学习记录都不丢
 * 保存后 rev 加一,返回保存后的进度和 rev,设备用它替换本地的进度。
 *
 * 同一个用户两台设备同时上传:行锁(select … for update)让它们排队,后到的那个会走合并。
 */
const MAX_BYTES = 1024 * 1024;
const LANG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

function langOf(req: FastifyRequest): string {
  const lang = (req.params as { lang?: string }).lang ?? "";
  if (!LANG.test(lang)) throw badRequest("语种不对", "invalid_lang");
  return lang;
}

export function registerSync(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;
  const path = ROUTES.progress(":lang");

  app.get(path, async (req): Promise<ProgressRes> => {
    const userId = await requireUser(req, config);
    const lang = langOf(req);
    const row = await db.selectFrom("progress").select(["data", "rev"]).where("user_id", "=", userId).where("lang", "=", lang).executeTakeFirst();
    return { progress: row?.data ?? null, rev: row?.rev ?? 0 };
  });

  app.put(path, async (req): Promise<ProgressRes> => {
    const userId = await requireUser(req, config);
    const lang = langOf(req);
    const { progress: raw, baseRev } = ProgressPutReq.parse(req.body, { error: () => "进度数据格式不对" });
    const json = JSON.stringify(raw ?? null);
    if (Buffer.byteLength(json) > MAX_BYTES) throw new HttpError(413, "progress_too_large", "学习进度数据太大,暂时无法同步");
    const incoming = parseProgress(raw);
    if (!incoming) throw badRequest("进度数据格式不对", "invalid_progress");
    if (incoming.lang !== lang) throw badRequest("进度的语种和地址不一致", "lang_mismatch");
    const now = deps.now();

    return db.transaction().execute(async (trx) => {
      // 先保证有这一行(没有就插一个空的占位),再锁住它:两个请求同时第一次上传也能排队
      await trx
        .insertInto("progress")
        .values({ user_id: userId, lang, data: null, rev: 0, updated_at: now })
        .onConflict((oc) => oc.columns(["user_id", "lang"]).doNothing())
        .execute();
      const cur = await trx
        .selectFrom("progress")
        .select(["data", "rev"])
        .where("user_id", "=", userId)
        .where("lang", "=", lang)
        .forUpdate()
        .executeTakeFirstOrThrow();

      let saved: Progress = incoming;
      if (cur.data != null && baseRev !== cur.rev) {
        const server = parseProgress(cur.data);
        if (server) saved = mergeProgress(server, incoming);
        // 服务器上的那份坏了(理论上不会:存之前都检查过)就以设备上传的为准,并留日志
        else req.log.error({ userId, lang }, "服务器上的进度格式不对,已用设备上传的覆盖");
      }
      const rev = cur.rev + 1;
      await trx
        .updateTable("progress")
        .set({ data: JSON.stringify(saved), rev, updated_at: now })
        .where("user_id", "=", userId)
        .where("lang", "=", lang)
        .execute();
      return { progress: saved, rev };
    });
  });
}
