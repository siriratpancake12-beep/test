import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Environment, SignedDataVerifier, VerificationException, VerificationStatus } from "@apple/app-store-server-library";
import { appleNotificationEvents, appleTransactionEvents } from "./apple-events";
import { StoreVerificationError, type AppStoreVerifier, type VerifiedNotification, type VerifiedTransaction } from "./types";

export type AppleEnvironment = "Production" | "Sandbox" | "LocalTesting";

export interface AppleVerifierOptions {
  bundleId: string;
  environment: AppleEnvironment;
  /** App 在 App Store 的数字 id(App Store Connect → App 信息 → Apple ID);生产环境必填 */
  appAppleId?: number;
  /** 苹果根证书(DER 或 PEM),见 loadAppleRootCertificates */
  rootCertificates: Buffer[];
  /** 在线检查证书吊销(OCSP,服务器要能访问苹果)。默认生产环境开、其他关 */
  onlineChecks?: boolean;
}

/**
 * 读取目录里的苹果根证书(.cer / .der / .crt / .pem)。
 * 证书是公开的,从 https://www.apple.com/certificateauthority/ 下载(至少 AppleRootCA-G3.cer),放在服务器上,不进仓库。
 */
export function loadAppleRootCertificates(dir: string): Buffer[] {
  return readdirSync(dir).filter((f) => /\.(cer|der|crt|pem)$/i.test(f)).sort().map((f) => readFileSync(join(dir, f)));
}

/**
 * 用苹果官方库(@apple/app-store-server-library)校验 App 上报的交易和 App Store 服务器通知 V2:
 * 证书链要能追到苹果根证书、签名正确、bundleId(生产环境还有 App 的数字 id)和环境一致,然后映射成订阅事件。
 */
export function createAppleVerifier(opts: AppleVerifierOptions): AppStoreVerifier {
  const online = opts.onlineChecks ?? opts.environment === "Production";
  const make = (env: Environment) =>
    new SignedDataVerifier(opts.rootCertificates, online, env, opts.bundleId, env === Environment.PRODUCTION ? opts.appAppleId : undefined);
  const verifiers =
    opts.environment === "Production"
      // 苹果审核和 TestFlight 用的是沙盒:生产服务器也要能确认沙盒交易,否则审核时买不了会员会被拒。
      // 沙盒交易只有我们建的测试账号、审核人员、TestFlight 测试员能产生,environment 会记成 Sandbox
      ? [make(Environment.PRODUCTION), make(Environment.SANDBOX)]
      : opts.environment === "Sandbox"
        ? [make(Environment.SANDBOX)]
        // 本机 Xcode StoreKit 测试:数据不是苹果签的,官方库会跳过签名校验,所以只能在开发环境用(服务器在生产环境会拒绝这个配置)
        : [make(Environment.XCODE), make(Environment.LOCAL_TESTING)];

  /**
   * 依次试各环境。签名、证书有问题直接拒绝;只有"环境 / App 标识对不上"才换下一个环境试——
   * 沙盒通知里没有 App 的数字 id,生产环境的校验器会报"App 标识不对",要交给沙盒的校验器。
   */
  async function decode<T>(fn: (v: SignedDataVerifier) => Promise<T>): Promise<{ value: T; verifier: SignedDataVerifier }> {
    const errors: unknown[] = [];
    for (const verifier of verifiers) {
      try {
        return { value: await fn(verifier), verifier };
      } catch (e) {
        errors.push(e);
        const wrongPlace = e instanceof VerificationException &&
          (e.status === VerificationStatus.INVALID_ENVIRONMENT || e.status === VerificationStatus.INVALID_APP_IDENTIFIER);
        if (!wrongPlace) break;
      }
    }
    // 报最能说明问题的那个:优先不是"环境不对"的
    const notEnv = errors.find((e) => !(e instanceof VerificationException && e.status === VerificationStatus.INVALID_ENVIRONMENT));
    throw toStoreError(notEnv ?? errors[errors.length - 1]);
  }
  const inner = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw toStoreError(e);
    }
  };

  return {
    async verifyTransaction(signedTransaction): Promise<VerifiedTransaction> {
      const { value: tx } = await decode((v) => v.verifyAndDecodeTransaction(signedTransaction));
      if (!tx.transactionId || !tx.originalTransactionId || !tx.productId) throw new StoreVerificationError("交易缺少必要字段", false, "missing_fields");
      return {
        originalTransactionId: tx.originalTransactionId,
        transactionId: tx.transactionId,
        productId: tx.productId,
        // 没设置时苹果给的是空字符串
        appAccountToken: tx.appAccountToken || undefined,
        environment: String(tx.environment ?? ""),
        periodEnd: tx.expiresDate !== undefined ? new Date(tx.expiresDate) : undefined,
        events: appleTransactionEvents(tx),
        raw: { transaction: tx },
      };
    },

    async verifyNotification(signedPayload): Promise<VerifiedNotification> {
      const { value: n, verifier } = await decode((v) => v.verifyAndDecodeNotification(signedPayload));
      if (!n.notificationUUID || !n.notificationType) throw new StoreVerificationError("通知缺少必要字段", false, "missing_fields");
      // 通知里的交易和续订信息是单独签名的,同样要校验(用同一个环境)
      const signedTx = n.data?.signedTransactionInfo;
      const signedRenewal = n.data?.signedRenewalInfo;
      const tx = signedTx ? await inner(() => verifier.verifyAndDecodeTransaction(signedTx)) : undefined;
      const renewal = signedRenewal ? await inner(() => verifier.verifyAndDecodeRenewalInfo(signedRenewal)) : undefined;
      const { signedTransactionInfo: _t, signedRenewalInfo: _r, ...data } = n.data ?? {};
      return {
        notificationUUID: n.notificationUUID,
        notificationType: String(n.notificationType),
        subtype: n.subtype ? String(n.subtype) : undefined,
        originalTransactionId: tx?.originalTransactionId ?? renewal?.originalTransactionId,
        transactionId: tx?.transactionId,
        productId: tx?.productId,
        appAccountToken: tx?.appAccountToken || renewal?.appAccountToken || undefined,
        environment: data.environment !== undefined ? String(data.environment) : undefined,
        periodEnd: tx?.expiresDate !== undefined ? new Date(tx.expiresDate) : undefined,
        signedAt: new Date(n.signedDate ?? Date.now()),
        events: appleNotificationEvents(n, tx, renewal),
        raw: { notification: { ...n, data }, transaction: tx, renewal },
      };
    },
  };
}

function toStoreError(e: unknown): StoreVerificationError {
  if (e instanceof StoreVerificationError) return e;
  if (e instanceof VerificationException) {
    const reason = VerificationStatus[e.status] ?? String(e.status);
    return new StoreVerificationError(`苹果签名校验失败:${reason}`, e.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE, reason, e.cause);
  }
  return new StoreVerificationError(`苹果签名校验失败:${e instanceof Error ? e.message : String(e)}`, false, "invalid", e);
}
