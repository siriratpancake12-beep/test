import * as AppleAuthentication from "expo-apple-authentication";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { AuthResult, Phone, ROUTES, SmsSendRes, User } from "@lingo/core";
import { api, ApiFailure, serverEnabled } from "./api";

/**
 * 账号:手机号 + 短信验证码、Sign in with Apple(仅 iOS)。
 * 微信登录要接微信的原生 SDK(需要在微信开放平台注册应用),这一版不显示按钮。
 *
 * 登录不是使用的前提:不登录也能完整地学。登录只为了换手机不丢进度、多台设备同步、购买会员。
 * 这里只有"和服务器打交道"和"凭证存哪儿";登录状态由 store.tsx 管。
 */
export type LoginMethod = "sms" | "apple";

export interface Session {
  token: string;
  user: User;
}

/**
 * 凭证存在系统安全存储(iOS 钥匙串、安卓 Keystore 加密),不放普通存储。
 * 网页预览没有安全存储,只能用 localStorage(网页版只给团队看界面、跑测试)。
 */
const KEY = "session";
const secure = Platform.OS === "web"
  ? {
      get: async (k: string) => localStorage.getItem(k),
      set: async (k: string, v: string) => localStorage.setItem(k, v),
      remove: async (k: string) => localStorage.removeItem(k),
    }
  : {
      get: (k: string) => SecureStore.getItemAsync(k),
      set: (k: string, v: string) => SecureStore.setItemAsync(k, v),
      remove: (k: string) => SecureStore.deleteItemAsync(k),
    };

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await secure.get(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { token?: unknown; user?: unknown };
    const user = User.safeParse(s.user);
    return typeof s.token === "string" && user.success ? { token: s.token, user: user.data } : null;
  } catch {
    return null;
  }
}

export const saveSession = (s: Session) => secure.set(KEY, JSON.stringify(s));

let userId: string | null = null;
/** 当前登录的账号 id(store.tsx 登录、恢复登录、退出时设置)。苹果内购用它把交易关联到账号 */
export const setCurrentUserId = (id: string | null) => {
  userId = id;
};
export const currentUserId = () => userId;

export async function clearSession(): Promise<void> {
  try {
    await secure.remove(KEY);
  } catch (e) {
    console.warn("清除登录凭证失败", e);
  }
}

/** 验证码重新发送的间隔(秒) */
export const SMS_RESEND_SECONDS = 60;

/** 手机号格式不对时返回提示,对了返回 null(规则和服务器一样,用 core 的 Phone) */
export function phoneError(phone: string): string | null {
  const r = Phone.safeParse(phone);
  return r.success ? null : (r.error.issues[0]?.message ?? "请输入正确的手机号");
}

export const codeValid = (code: string) => /^\d{6}$/.test(code);

export async function sendSmsCode(phone: string): Promise<void> {
  await api("POST", ROUTES.smsSend, { phone }, SmsSendRes);
}

export function verifySmsCode(phone: string, code: string): Promise<AuthResult> {
  return api("POST", ROUTES.smsVerify, { phone, code }, AuthResult);
}

/** iOS 13 以上才有 Apple 登录;安卓和网页不显示 */
export async function appleAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios" || !serverEnabled()) return false;
  return AppleAuthentication.isAvailableAsync().catch(() => false);
}

/**
 * Apple 登录。不要姓名和邮箱(用不到就不收集),服务器只校验 identityToken 拿到苹果用户 id。
 * 授权码一起交给服务器:服务器用它向苹果换刷新令牌,注销账号时撤销授权(苹果要求)。
 * 用户自己取消返回 null,不算出错。
 */
export async function appleSignIn(): Promise<AuthResult | null> {
  let cred: AppleAuthentication.AppleAuthenticationCredential;
  try {
    cred = await AppleAuthentication.signInAsync({ requestedScopes: [] });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_REQUEST_CANCELED") return null;
    throw new ApiFailure(0, "apple", "Apple 登录没有成功,请稍后再试");
  }
  if (!cred.identityToken) throw new ApiFailure(0, "apple", "Apple 登录没有成功,请稍后再试");
  const body = { identityToken: cred.identityToken, ...(cred.authorizationCode ? { authorizationCode: cred.authorizationCode } : {}) };
  return api("POST", ROUTES.appleLogin, body, AuthResult);
}

/** 注销账号:服务器删除账号和云端数据。失败会抛出 ApiFailure(本机什么都不动)。 */
export async function deleteAccountOnServer(): Promise<void> {
  await api("DELETE", ROUTES.account);
}

export const maskPhone = (p: string) => (/^\d{11}$/.test(p) ? `${p.slice(0, 3)}****${p.slice(7)}` : p);

/** 设置页显示的"当前账号" */
export function accountLabel(u: User): string {
  if (u.phone) return `手机号 ${maskPhone(u.phone)}`;
  if (u.hasApple) return "Apple 账号";
  if (u.hasWechat) return "微信账号";
  return "已登录";
}

/** 给用户看的错误文字:服务器的中文 message 直接用,其他情况给一句通用的 */
export const errorText = (e: unknown) => (e instanceof ApiFailure ? e.message : "出错了,请稍后再试");
