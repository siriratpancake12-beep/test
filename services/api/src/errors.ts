import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

/**
 * Fastify 自己产生的 4xx(请求体解析、地址格式等)原本是英文提示,换成中文。
 * 没列出来的 4xx 用通用的中文提示,不把框架的英文原文给用户看。
 */
const FRAMEWORK_4XX: Record<string, [code: string, message: string]> = {
  FST_ERR_CTP_INVALID_JSON_BODY: ["invalid_json", "请求内容不是合法的 JSON"],
  FST_ERR_CTP_EMPTY_JSON_BODY: ["empty_body", "请求内容不能为空"],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: ["unsupported_media_type", "不支持这种请求格式"],
  FST_ERR_CTP_BODY_TOO_LARGE: ["body_too_large", "上传的内容太大了"],
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: ["bad_request", "请求内容不完整,请重试"],
  FST_ERR_BAD_URL: ["bad_url", "请求地址不对"],
  FST_ERR_MAX_PARAM_LENGTH: ["bad_url", "请求地址太长"],
};

function send(err: FastifyError | HttpError | ZodError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
  if (err instanceof ZodError) {
    return reply.status(400).send({ error: { code: "invalid", message: err.issues[0]?.message ?? "请求格式不对" } });
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) {
    req.log.error(err);
    return reply.status(status).send({ error: { code: "internal", message: "服务器出错了,请稍后再试" } });
  }
  const [code, message] = FRAMEWORK_4XX[(err as FastifyError).code ?? ""] ?? ["bad_request", "请求格式不对"];
  return reply.status(status).send({ error: { code, message } });
}

/**
 * 路由之前就出的错(地址里的百分号编码坏了等)不经过 setErrorHandler,
 * 要在建 Fastify 时作为 frameworkErrors 选项传进去(见 app.ts),否则会返回 Fastify 默认的英文 JSON。
 */
export function frameworkErrors(err: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  void send(err, req, reply);
}

/** 统一错误格式:{ error: { code, message } };找不到的接口也是这个格式 */
export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => send(err, req, reply));
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "找不到这个接口" } }));
}
