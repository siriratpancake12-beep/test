import type { WechatClient } from "../routes/auth";

/**
 * 微信登录(移动应用):App 通过微信 SDK 拿到 code,服务器用 AppID + AppSecret 换用户身份。
 * https://api.weixin.qq.com/sns/oauth2/access_token?appid=…&secret=…&code=…&grant_type=authorization_code
 * 只取 openid / unionid 认人;返回的 access_token 用不上,不保存(少存一样个人信息)。
 * AppSecret 只在服务器上,绝不能下发到 App。
 */
export const WECHAT_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";

/** 微信返回的错误。invalidCode = code 无效、过期或已经用过(让用户重新点一次微信登录) */
export class WechatError extends Error {
  constructor(public errcode: number, errmsg: string) {
    super(`微信登录失败:${errcode} ${errmsg}`);
  }
  /** 40029 code 无效;40163 code 已被使用;42003 code 超时 */
  get invalidCode(): boolean {
    return this.errcode === 40029 || this.errcode === 40163 || this.errcode === 42003;
  }
}

export function createWechatClient(appId: string, appSecret: string, fetchFn: typeof fetch = fetch): WechatClient {
  return {
    async exchange(code) {
      const url = `${WECHAT_TOKEN_URL}?${new URLSearchParams({ appid: appId, secret: appSecret, code, grant_type: "authorization_code" })}`;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new WechatError(-res.status, `HTTP ${res.status}`);
      // 微信出错时也是 HTTP 200,内容里带 errcode;content-type 有时是 text/plain,所以按文本解析
      let data: { openid?: string; unionid?: string; errcode?: number; errmsg?: string };
      try {
        data = JSON.parse(await res.text());
      } catch {
        throw new WechatError(-1, "返回的不是 JSON");
      }
      if (data.errcode) throw new WechatError(data.errcode, data.errmsg ?? "");
      if (!data.openid) throw new WechatError(-1, "没有 openid");
      return { openid: data.openid, unionid: data.unionid || undefined };
    },
  };
}
