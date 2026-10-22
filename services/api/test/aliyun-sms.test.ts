import { describe, expect, it, vi } from "vitest";
import { testConfig } from "../src/config";
import { AliyunSmsError, aliyunEncode, buildSendSmsRequest, createAliyunSmsSender, signAliyunV3, type AliyunSmsConfig } from "../src/auth/aliyun-sms";
import { createSmsSender } from "../src/routes/auth";

const cfg: AliyunSmsConfig = { accessKeyId: "testAccessKeyId", accessKeySecret: "testAccessKeySecret", signName: "语途", templateCode: "SMS_123456789" };
const NOW = new Date("2026-11-01T12:00:00.123Z");
const NONCE = "3156853299f313e23d1673dc12e1703d";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * 参考值:用阿里云官方 SDK(@alicloud/openapi-util 0.3.3 的 getAuthorization)对同样的输入算出来的。
 * 我们的实现和它逐字一致,才能保证真实调用时签名能通过。
 */
const EXPECTED_CANONICAL = [
  "POST",
  "/",
  "PhoneNumbers=13800138000&SignName=%E8%AF%AD%E9%80%94&TemplateCode=SMS_123456789&TemplateParam=%7B%22code%22%3A%22123456%22%7D",
  "host:dysmsapi.aliyuncs.com",
  "x-acs-action:SendSms",
  `x-acs-content-sha256:${EMPTY_SHA256}`,
  "x-acs-date:2026-11-01T12:00:00Z",
  `x-acs-signature-nonce:${NONCE}`,
  "x-acs-version:2017-05-25",
  "",
  "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
  EMPTY_SHA256,
].join("\n");
const EXPECTED_SIGNATURE = "c60863ae3176f4e2d26eb3a5949c7ed79f27d0693f8ae651f93fdeef3a3d896e";

describe("阿里云 V3 签名", () => {
  it("编码:RFC 3986(空格 %20、* 编码、~ 不编码)", () => {
    expect(aliyunEncode("a b*c~d!'()")).toBe("a%20b%2Ac~d%21%27%28%29");
    expect(aliyunEncode("语途")).toBe("%E8%AF%AD%E9%80%94");
    expect(aliyunEncode("-_.")).toBe("-_.");
  });

  it("和官方 SDK 算出的签名一致", () => {
    const signed = signAliyunV3({
      method: "POST",
      path: "/",
      query: { TemplateParam: '{"code":"123456"}', PhoneNumbers: "13800138000", TemplateCode: "SMS_123456789", SignName: "语途" },
      headers: {
        Host: "dysmsapi.aliyuncs.com",
        "x-acs-action": "SendSms",
        "x-acs-version": "2017-05-25",
        "x-acs-date": "2026-11-01T12:00:00Z",
        "x-acs-signature-nonce": `  ${NONCE} `,
        "x-acs-content-sha256": EMPTY_SHA256,
        accept: "application/json",
        "user-agent": "不参与签名",
      },
      body: "",
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
    });
    expect(signed.canonicalRequest).toBe(EXPECTED_CANONICAL);
    expect(signed.stringToSign).toBe("ACS3-HMAC-SHA256\nec4e8bcffc2e0ffd8778709364053c057f1c90a39bbfcbab9d3dc88983377414");
    expect(signed.signature).toBe(EXPECTED_SIGNATURE);
    expect(signed.authorization).toBe(
      `ACS3-HMAC-SHA256 Credential=testAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=${EXPECTED_SIGNATURE}`,
    );
  });

  it("请求体参与签名,换了密钥签名就不同", () => {
    const base = { method: "POST", path: "/", query: {}, headers: { host: "x" }, accessKeyId: "a", accessKeySecret: "s" };
    const a = signAliyunV3({ ...base, body: "" });
    expect(signAliyunV3({ ...base, body: "x=1" }).signature).not.toBe(a.signature);
    expect(signAliyunV3({ ...base, body: "", accessKeySecret: "t" }).signature).not.toBe(a.signature);
  });
});

describe("阿里云短信 SendSms", () => {
  it("组装的请求:参数在查询串里,签名头齐全(时间精确到秒)", () => {
    const { url, init } = buildSendSmsRequest(cfg, "13800138000", "123456", NOW, NONCE);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://dysmsapi.aliyuncs.com/");
    expect(Object.fromEntries(u.searchParams)).toEqual({ PhoneNumbers: "13800138000", SignName: "语途", TemplateCode: "SMS_123456789", TemplateParam: '{"code":"123456"}' });
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-acs-action": "SendSms",
      "x-acs-version": "2017-05-25",
      "x-acs-date": "2026-11-01T12:00:00Z",
      "x-acs-signature-nonce": NONCE,
      "x-acs-content-sha256": EMPTY_SHA256,
    });
    // 和官方算法对同样的请求算出的结果一样
    expect(init.headers.authorization).toContain(`Signature=${EXPECTED_SIGNATURE}`);
    expect(init.headers).not.toHaveProperty("host");
  });

  it("阿里云返回 OK 就算发出去了;返回错误码时抛错", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let reply: Response = new Response(JSON.stringify({ Code: "OK", Message: "OK", BizId: "1", RequestId: "r1" }));
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return reply;
    }) as unknown as typeof fetch;
    const sender = createAliyunSmsSender(cfg, fakeFetch, () => NOW);
    await sender.send("13800138000", "654321");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("TemplateParam")).toBe('{"code":"654321"}');

    reply = new Response(JSON.stringify({ Code: "isv.BUSINESS_LIMIT_CONTROL", Message: "触发分钟级流控", RequestId: "r2" }));
    await expect(sender.send("13800138000", "654321")).rejects.toMatchObject({ code: "isv.BUSINESS_LIMIT_CONTROL", requestId: "r2" });
    reply = new Response("<html>bad gateway</html>", { status: 502 });
    await expect(sender.send("13800138000", "654321")).rejects.toBeInstanceOf(AliyunSmsError);
  });

  it("按配置选短信服务:开发用日志;SMS_PROVIDER=aliyun 但配置不全时启动就报错", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createSmsSender(testConfig()).send("13800138000", "123456");
    expect(log).toHaveBeenCalledWith("[开发短信] 13800138000 验证码 123456");
    log.mockRestore();

    const base = testConfig();
    expect(() => createSmsSender({ ...base, sms: { provider: "aliyun", aliyunAccessKeyId: "id" } })).toThrow(
      "SMS_PROVIDER=aliyun 时必须设置 ALIYUN_ACCESS_KEY_SECRET、SMS_SIGN_NAME、SMS_TEMPLATE_CODE",
    );
    const full = createSmsSender({ ...base, sms: { provider: "aliyun", aliyunAccessKeyId: "id", aliyunAccessKeySecret: "s", signName: "语途", templateCode: "SMS_1" } });
    expect(full).not.toBe(createSmsSender(base));
  });
});
