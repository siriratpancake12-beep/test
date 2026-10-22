import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

/** 业务错误:status + 机器可读的 code + 给用户看的中文 message。 */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message = "请先登录") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "没有权限") => new HttpError(403, "forbidden", message);
export const notFound = (message = "找不到") => new HttpError(404, "not_found", message);
export const tooMany = (message = "操作太频繁,请稍后再试") => new HttpError(429, "too_many_requests", message);

/** 统一错误格式:{ error: { code, message } } */
export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "invalid", message: err.issues[0]?.message ?? "请求格式不对" } });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({ error: { code: status >= 500 ? "internal" : "bad_request", message: status >= 500 ? "服务器出错了,请稍后再试" : err.message } });
  });
}
