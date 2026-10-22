import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Environment, NotificationTypeV2 as N, Subtype } from "@apple/app-store-server-library";
import { createAppleVerifier, loadAppleRootCertificates, StoreVerificationError } from "../src/index";
import { createFakeApple } from "./fake-apple";
import { appleNotification, appleRenewal, appleTx, at, BUNDLE_ID, trialTx } from "./payloads";

const apple = createFakeApple();
const sandbox = createAppleVerifier({ bundleId: BUNDLE_ID, environment: "Sandbox", rootCertificates: [apple.rootCert] });
const production = createAppleVerifier({ bundleId: BUNDLE_ID, environment: "Production", appAppleId: 1234567890, rootCertificates: [apple.rootCert], onlineChecks: false });
const userId = "6f1c5c3e-2b7a-4d3e-9a51-0f6f2a8b9c10";

async function rejection(p: Promise<unknown>): Promise<StoreVerificationError> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(StoreVerificationError);
  return e as StoreVerificationError;
}

describe("校验 App 上报的交易(用自己生成的证书链,走官方库的真实校验)", () => {
  it("签名正确:解出交易和事件", async () => {
    const v = await sandbox.verifyTransaction(apple.transaction(trialTx({ appAccountToken: userId })));
    expect(v).toMatchObject({
      originalTransactionId: "2000000001", transactionId: "2000000001", productId: "premium_yearly",
      appAccountToken: userId, environment: "Sandbox", periodEnd: new Date(at(7)),
    });
    expect(v.events.map((e) => e.type)).toEqual(["start-trial"]);
  });

  it("没设置 appAccountToken(苹果给空字符串)时当作没有", async () => {
    const v = await sandbox.verifyTransaction(apple.transaction(appleTx({ appAccountToken: "" })));
    expect(v.appAccountToken).toBeUndefined();
  });

  it("内容被改过、不是苹果根证书签的、证书缺少苹果标记:拒绝", async () => {
    const signed = apple.transaction(appleTx());
    const [h, , s] = signed.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify(appleTx({ expiresDate: at(3650) }))).toString("base64url")}.${s}`;
    const e = await rejection(sandbox.verifyTransaction(forged));
    expect(e).toMatchObject({ reason: "VERIFICATION_FAILURE", retryable: false });
    // 证书链没问题,是签名对不上
    expect(String(e.cause)).toContain("invalid signature");
    expect((await rejection(sandbox.verifyTransaction(createFakeApple().transaction(appleTx())))).reason).toBe("VERIFICATION_FAILURE");
    const unmarked = createFakeApple({ markers: false });
    const trustsUnmarked = createAppleVerifier({ bundleId: BUNDLE_ID, environment: "Sandbox", rootCertificates: [unmarked.rootCert] });
    expect((await rejection(trustsUnmarked.verifyTransaction(unmarked.transaction(appleTx())))).reason).toBe("VERIFICATION_FAILURE");
    // 对照:同一条链带上苹果标记就能通过,说明上面是因为缺标记才被拒
    const marked = createFakeApple();
    const trustsMarked = createAppleVerifier({ bundleId: BUNDLE_ID, environment: "Sandbox", rootCertificates: [marked.rootCert] });
    await expect(trustsMarked.verifyTransaction(marked.transaction(appleTx()))).resolves.toMatchObject({ productId: "premium_yearly" });
    await rejection(sandbox.verifyTransaction("not-a-jws"));
  });

  it("别的 App 的交易、环境不对:拒绝", async () => {
    expect((await rejection(sandbox.verifyTransaction(apple.transaction(appleTx({ bundleId: "com.other.app" }))))).reason).toBe("INVALID_APP_IDENTIFIER");
    expect((await rejection(sandbox.verifyTransaction(apple.transaction(appleTx({ environment: Environment.PRODUCTION }))))).reason).toBe("INVALID_ENVIRONMENT");
  });

  it("生产环境也接受沙盒交易(苹果审核、TestFlight 用沙盒),并标明环境", async () => {
    expect((await production.verifyTransaction(apple.transaction(appleTx({ environment: Environment.PRODUCTION })))).environment).toBe("Production");
    expect((await production.verifyTransaction(apple.transaction(appleTx()))).environment).toBe("Sandbox");
  });
});

describe("校验 App Store 服务器通知", () => {
  it("通知和里面的交易、续订信息都要校验;解出用户标识和事件", async () => {
    const n = appleNotification(N.DID_CHANGE_RENEWAL_STATUS, Subtype.AUTO_RENEW_DISABLED, 3, "6a1b2c3d-0000-4000-8000-000000000001");
    const signed = apple.notification(n, {
      bundleId: BUNDLE_ID, environment: "Sandbox",
      tx: trialTx({ appAccountToken: userId }), renewal: appleRenewal({ autoRenewStatus: 0, appAccountToken: userId }),
    });
    const v = await sandbox.verifyNotification(signed);
    expect(v).toMatchObject({
      notificationUUID: n.notificationUUID, notificationType: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_DISABLED",
      originalTransactionId: "2000000001", transactionId: "2000000001", appAccountToken: userId, environment: "Sandbox",
      periodEnd: new Date(at(7)), signedAt: new Date(at(3)),
    });
    expect(v.events.map((e) => [e.type, "on" in e ? e.on : null])).toEqual([["start-trial", null], ["auto-renew", false]]);
    // 原始数据里不再重复存签名串
    expect(JSON.stringify(v.raw)).not.toContain(signed.slice(0, 40));
  });

  it("测试通知没有交易", async () => {
    const v = await sandbox.verifyNotification(apple.notification(appleNotification(N.TEST), { bundleId: BUNDLE_ID, environment: "Sandbox" }));
    expect(v).toMatchObject({ notificationType: "TEST", events: [] });
    expect(v.originalTransactionId).toBeUndefined();
  });

  it("通知里夹带的交易不是苹果签的:拒绝", async () => {
    const forgedTx = createFakeApple().transaction(appleTx());
    const payload = { ...appleNotification(N.DID_RENEW), data: { bundleId: BUNDLE_ID, environment: "Sandbox", signedTransactionInfo: forgedTx } };
    await rejection(sandbox.verifyNotification(apple.jws(payload)));
  });

  it("生产环境的通知还要核对 App 的数字 id;沙盒通知(没有数字 id)交给沙盒校验", async () => {
    const ok = apple.notification(appleNotification(N.TEST), { bundleId: BUNDLE_ID, environment: "Production", appAppleId: 1234567890 });
    expect((await production.verifyNotification(ok)).environment).toBe("Production");
    const other = apple.notification(appleNotification(N.TEST), { bundleId: BUNDLE_ID, environment: "Production", appAppleId: 42 });
    expect((await rejection(production.verifyNotification(other))).reason).toBe("INVALID_APP_IDENTIFIER");
    // 苹果审核、TestFlight 的购买产生的是沙盒通知,里面没有 appAppleId
    const review = apple.notification(appleNotification(N.SUBSCRIBED, Subtype.INITIAL_BUY), { bundleId: BUNDLE_ID, environment: "Sandbox", tx: trialTx({ appAccountToken: userId }) });
    expect(await production.verifyNotification(review)).toMatchObject({ environment: "Sandbox", appAccountToken: userId });
    // 别的 App 的沙盒通知照样拒绝
    const otherApp = apple.notification(appleNotification(N.TEST), { bundleId: "com.other.app", environment: "Sandbox" });
    expect((await rejection(production.verifyNotification(otherApp))).reason).toBe("INVALID_APP_IDENTIFIER");
  });
});

describe("苹果根证书", () => {
  const dir = mkdtempSync(join(tmpdir(), "apple-roots-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("从配置的目录读取 .cer/.der/.crt/.pem,忽略其他文件", () => {
    writeFileSync(join(dir, "AppleRootCA-G3.cer"), apple.rootCert);
    writeFileSync(join(dir, "README.txt"), "下载自 https://www.apple.com/certificateauthority/");
    const certs = loadAppleRootCertificates(dir);
    expect(certs).toHaveLength(1);
    expect(certs[0]!.equals(apple.rootCert)).toBe(true);
  });
});
