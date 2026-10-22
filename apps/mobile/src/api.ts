import Constants from "expo-constants";
import type { ZodType } from "zod";

/**
 * 服务器接口的客户端。接口约定见 packages/core/src/api.ts(ROUTES 和请求/响应格式)。
 * 没配置服务器地址(app.json 的 extra.apiBase 为空)时,App 完全离线运行:不登录、不同步。
 */
export const API_BASE: string = ((Constants.expoConfig?.extra ?? {}) as { apiBase?: string }).apiBase ?? "";
export const serverEnabled = () => API_BASE.length > 0;

let token: string | null = null;
/** 登录凭证。持久化(系统安全存储)由账号模块负责,这里只保存当前值。 */
export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** 调用服务器接口。出错时抛出 ApiFailure,message 是可以直接给用户看的中文。 */
export async function api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, schema?: ZodType<T>, timeoutMs = 15000): Promise<T> {
  if (!serverEnabled()) throw new ApiFailure(0, "offline", "没有连接服务器");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiFailure(res.status, e?.code ?? "http_error", e?.message ?? "网络出错了,请稍后再试");
    }
    return schema ? schema.parse(data) : (data as T);
  } catch (e) {
    if (e instanceof ApiFailure) throw e;
    throw new ApiFailure(0, "network", "网络连接失败,请检查网络");
  } finally {
    clearTimeout(timer);
  }
}
