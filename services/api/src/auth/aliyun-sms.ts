import { createHash, createHmac, randomUUID } from "node:crypto";
import type { SmsNotifier, SmsSender } from "../routes/auth";

/**
 * 阿里云短信(SendSms,API 版本 2017-05-25),按阿里云 OpenAPI 的 V3 签名(ACS3-HMAC-SHA256)直接调用,
 * 不引入阿里云 SDK(依赖多,而我们只用这一个接口)。签名算法和官方 SDK(@alicloud/openapi-util 的 getAuthorization)一致:
 *
 *   CanonicalRequest = 方法 \n 路径 \n 规范化查询串 \n 规范化请求头(每行 "名:值\n") \n 参与签名的头(;分隔) \n hex(sha256(请求体))
 *   StringToSign     = "ACS3-HMAC-SHA256" \n hex(sha256(CanonicalRequest))
 *   Signature        = hex(hmac-sha256(AccessKeySecret, StringToSign))
 *   Authorization    = ACS3-HMAC-SHA256 Credential=<AccessKeyId>,SignedHeaders=<...>,Signature=<...>
 *
 * 参与签名的头:host、content-type 和所有 x-acs- 开头的头,名字转小写、按字母排序、值去掉首尾空格。
 * 验证码模板里的变量必须叫 ${code};通知短信(扣费前提醒)的变量由调用方给。
 * AccessKey 用只有短信发送权限的 RAM 子账号,只放在环境变量里。
 */
export const ALIYUN_SMS_HOST = "dysmsapi.aliyuncs.com";
const ALGORITHM = "ACS3-HMAC-SHA256";

/** AccessKey 和短信签名:验证码短信、通知短信共用 */
export interface AliyunSmsAccount {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
}

export interface AliyunSmsConfig extends AliyunSmsAccount {
  /** 验证码模板 */
  templateCode: string;
}

/** RFC 3986 编码:只有字母、数字和 - _ . ~ 不编码,空格是 %20(encodeURIComponent 不编码 ! ' ( ) *,要补上) */
export function aliyunEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignInput {
  method: string;
  path: string;
  query: Record<string, string>;
  /** 请求头(名字大小写随意);参与签名的会按规则挑出来 */
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  accessKeySecret: string;
}

export interface Signed {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  authorization: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** V3 签名(纯函数,便于测试)。headers 里要已经有 x-acs-content-sha256 等需要签名的头。 */
export function signAliyunV3(input: SignInput): Signed {
  const query = Object.keys(input.query)
    .sort()
    .map((k) => `${aliyunEncode(k)}=${aliyunEncode(input.query[k]!)}`)
    .join("&");
  const signedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    const name = k.toLowerCase();
    if (name === "host" || name === "content-type" || name.startsWith("x-acs-")) signedHeaders[name] = v.trim();
  }
  const names = Object.keys(signedHeaders).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signedHeaders[n]}\n`).join("");
  const canonicalRequest = [input.method.toUpperCase(), input.path, query, canonicalHeaders, names.join(";"), sha256hex(input.body)].join("\n");
  const stringToSign = `${ALGORITHM}\n${sha256hex(canonicalRequest)}`;
  const signature = createHmac("sha256", input.accessKeySecret).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalRequest,
    stringToSign,
    signature,
    authorization: `${ALGORITHM} Credential=${input.accessKeyId},SignedHeaders=${names.join(";")},Signature=${signature}`,
  };
}

/** x-acs-date 的格式:UTC,精确到秒,形如 2026-11-01T12:00:00Z */
export const acsDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

type SmsRequest = { url: string; init: { method: "POST"; headers: Record<string, string> } };

/** 验证码短信(模板变量 ${code}) */
export function buildSendSmsRequest(cfg: AliyunSmsConfig, phone: string, code: string, now: Date, nonce: string): SmsRequest {
  return buildTemplateSmsRequest(cfg, phone, cfg.templateCode, { code }, now, nonce);
}

/** 组装一次 SendSms 请求(纯函数:时间和随机数从外面传入)。params 是模板变量,对应模板里的 ${名字} */
export function buildTemplateSmsRequest(
  acct: AliyunSmsAccount, phone: string, templateCode: string, params: Record<string, string>, now: Date, nonce: string,
): SmsRequest {
  const query = {
    PhoneNumbers: phone,
    SignName: acct.signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify(params),
  };
  const body = "";
  const headers: Record<string, string> = {
    host: ALIYUN_SMS_HOST,
    "x-acs-action": "SendSms",
    "x-acs-version": "2017-05-25",
    "x-acs-date": acsDate(now),
    "x-acs-signature-nonce": nonce,
    "x-acs-content-sha256": sha256hex(body),
    accept: "application/json",
  };
  const { authorization } = signAliyunV3({ method: "POST", path: "/", query, headers, body, accessKeyId: acct.accessKeyId, accessKeySecret: acct.accessKeySecret });
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${aliyunEncode(k)}=${aliyunEncode(query[k as keyof typeof query])}`)
    .join("&");
  // host 头由 fetch 根据地址自己加(不能手动设),值和签名用的一样
  const { host: _host, ...sendHeaders } = headers;
  return { url: `https://${ALIYUN_SMS_HOST}/?${qs}`, init: { method: "POST", headers: { ...sendHeaders, authorization } } };
}

/** 阿里云返回的错误(Code 不是 OK)。Code 例如 isv.BUSINESS_LIMIT_CONTROL(触发了阿里云自己的频率限制) */
export class AliyunSmsError extends Error {
  constructor(public code: string, message: string, public requestId?: string) {
    super(`阿里云短信发送失败:${code} ${message}`);
  }
}

/** 发出一次请求;阿里云没回 OK 就抛 AliyunSmsError(确定没发出去)。超时抛 TimeoutError(不确定发没发出去) */
async function callSendSms(fetchFn: typeof fetch, { url, init }: SmsRequest): Promise<void> {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let data: { Code?: string; Message?: string; RequestId?: string } = {};
  try {
    data = JSON.parse(text);
  } catch {
    // 网关错误等返回的不一定是 JSON
  }
  if (!res.ok || data.Code !== "OK") throw new AliyunSmsError(data.Code ?? `HTTP ${res.status}`, data.Message ?? text.slice(0, 200), data.RequestId);
}

export function createAliyunSmsSender(cfg: AliyunSmsConfig, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): SmsSender {
  return {
    async send(phone, code) {
      await callSendSms(fetchFn, buildSendSmsRequest(cfg, phone, code, now(), randomUUID()));
    },
  };
}

/** 通知短信(扣费前提醒等):用同一个 AccessKey 和签名,模板和变量由调用方给 */
export function createAliyunSmsNotifier(acct: AliyunSmsAccount, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): SmsNotifier {
  return {
    async notify(phone, templateCode, params) {
      await callSendSms(fetchFn, buildTemplateSmsRequest(acct, phone, templateCode, params, now(), randomUUID()));
    },
  };
}
