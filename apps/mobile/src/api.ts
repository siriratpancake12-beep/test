import Constants from "expo-constants";
import { Platform } from "react-native";
import type { ZodType } from "zod";

/**
 * 服务器接口的客户端。接口约定见 packages/core/src/api.ts(ROUTES 和请求/响应格式)。
 * 没配置服务器地址(app.json 的 extra.apiBase 为空)时,App 完全离线运行:不登录、不同步。
 *
 * 网页预览可以在页面加载前设置 window.__LINGO_API_BASE__ 指向测试服务器(端到端测试用这个测登录和同步);
 * 手机上只认 app.json 里的地址。
 */
const configured = ((Constants.expoConfig?.extra ?? {}) as { apiBase?: string }).apiBase ?? "";
const webOverride = Platform.OS === "web" ? (globalThis as { __LINGO_API_BASE__?: unknown }).__LINGO_API_BASE__ : undefined;
export const API_BASE: string = typeof webOverride === "string" ? webOverride : configured;
export const serverEnabled = () => API_BASE.length > 0;

let token: string | null = null;
/** 登录凭证。持久化(系统安全存储)由账号模块负责,这里只保存当前值。 */
export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;

let unauthorized: (() => void) | null = null;
/**
 * 带着凭证的请求被服务器拒绝(401:过期、账号已注销)时调用。
 * 账号模块用它在本机退出登录,否则同步和埋点上传会一直带着无效凭证失败。
 */
export const onUnauthorized = (fn: (() => void) | null) => { unauthorized = fn; };

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
  const sent = token;
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(sent ? { authorization: `Bearer ${sent}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      // 只有失效的正是当前凭证才算退出(请求途中换了账号的,不影响新账号)
      if (res.status === 401 && sent && sent === token) unauthorized?.();
      const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiFailure(res.status, e?.code ?? "http_error", e?.message ?? "网络出错了,请稍后再试");
    }
    if (!schema) return data as T;
    // 格式不对是服务器的问题,不要说成"网络连接失败"
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new ApiFailure(res.status, "bad_response", "服务器返回的数据有误,请稍后再试");
    return parsed.data;
  } catch (e) {
    if (e instanceof ApiFailure) throw e;
    throw new ApiFailure(0, "network", "网络连接失败,请检查网络");
  } finally {
    clearTimeout(timer);
  }
}
