import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import type { JWSRenewalInfoDecodedPayload, JWSTransactionDecodedPayload, ResponseBodyV2DecodedPayload } from "@apple/app-store-server-library";

/**
 * 测试用的"假苹果":自己生成一条和苹果结构一样的证书链(根 → 中间 → 签名证书,带苹果的标记扩展),
 * 用它签 JWS。把这个根证书交给官方库当"苹果根证书",就能在不联网的情况下测签名校验的真实代码路径。
 * 每次运行现场生成,不提交任何证书或私钥。
 */

// ---- 最小的 DER 编码(只够生成证书) ----
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...body: Buffer[]) => {
  const b = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), len(b.length), b]);
};
const seq = (...b: Buffer[]) => tlv(0x30, ...b);
const set = (...b: Buffer[]) => tlv(0x31, ...b);
function int(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
function oid(s: string): Buffer {
  const [a, b, ...rest] = s.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
/** UTCTime:YYMMDDHHMMSSZ */
const utcTime = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const ctx = (n: number, ...b: Buffer[]) => tlv(0xa0 + n, ...b);
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const NULL = Buffer.from([0x05, 0x00]);
const dn = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))), set(seq(oid("2.5.4.10"), utf8("Lingo Test"))));
const ext = (id: string, value: Buffer, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), tlv(0x04, value));

/** 苹果证书链里的标记扩展:中间证书(WWDR)和 App Store 签名证书各有一个,官方库会检查 */
export const APPLE_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
export const APPLE_LEAF_OID = "1.2.840.113635.100.6.11.1";

function cert(o: { serial: number; subject: string; issuer: string; key: KeyObject; signer: KeyObject; ca: boolean; marker?: string; from: Date; to: Date }): Buffer {
  const exts = [ext("2.5.29.19", o.ca ? seq(bool(true)) : seq(), true)];
  if (o.marker) exts.push(ext(o.marker, NULL));
  const tbs = seq(
    ctx(0, int(2)), int(o.serial), ECDSA_SHA256, dn(o.issuer), seq(utcTime(o.from), utcTime(o.to)), dn(o.subject),
    o.key.export({ type: "spki", format: "der" }), ctx(3, seq(...exts)),
  );
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sign("sha256", tbs, o.signer)));
}

export interface FakeApple {
  /** 根证书(DER),交给 SignedDataVerifier 当苹果根证书 */
  rootCert: Buffer;
  /** 用这条链签任意内容 */
  jws(payload: object): string;
  transaction(tx: JWSTransactionDecodedPayload): string;
  renewal(info: JWSRenewalInfoDecodedPayload): string;
  /** 签一条服务器通知;tx、renewal 会先单独签好放进 data 里,和苹果一样 */
  notification(n: Omit<ResponseBodyV2DecodedPayload, "data">, data: { tx?: JWSTransactionDecodedPayload; renewal?: JWSRenewalInfoDecodedPayload; bundleId: string; environment: string; appAppleId?: number }): string;
}

export function createFakeApple(opts: { markers?: boolean } = {}): FakeApple {
  const markers = opts.markers ?? true;
  const ec = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const root = ec(), mid = ec(), leaf = ec();
  const from = new Date("2020-01-01T00:00:00Z"), to = new Date("2045-01-01T00:00:00Z");
  const tag = randomUUID().slice(0, 8);
  const rootName = `Fake Apple Root ${tag}`, midName = `Fake Apple WWDR ${tag}`;
  const rootCert = cert({ serial: 1, subject: rootName, issuer: rootName, key: root.publicKey, signer: root.privateKey, ca: true, from, to });
  const midCert = cert({ serial: 2, subject: midName, issuer: rootName, key: mid.publicKey, signer: root.privateKey, ca: true, marker: markers ? APPLE_INTERMEDIATE_OID : undefined, from, to });
  const leafCert = cert({ serial: 3, subject: `Fake App Store ${tag}`, issuer: midName, key: leaf.publicKey, signer: mid.privateKey, ca: false, marker: markers ? APPLE_LEAF_OID : undefined, from, to });
  const x5c = [leafCert, midCert, rootCert].map((c) => c.toString("base64"));
  const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

  const jws = (payload: object) => {
    const signingInput = `${b64(JSON.stringify({ alg: "ES256", x5c }))}.${b64(JSON.stringify(payload))}`;
    // JWS 的 ES256 签名是 r||s(64 字节),不是 DER
    return `${signingInput}.${b64(sign("sha256", Buffer.from(signingInput), { key: leaf.privateKey, dsaEncoding: "ieee-p1363" }))}`;
  };
  return {
    rootCert,
    jws,
    transaction: (tx) => jws(tx),
    renewal: (info) => jws(info),
    notification: (n, d) => jws({
      ...n,
      data: {
        bundleId: d.bundleId, environment: d.environment, ...(d.appAppleId !== undefined ? { appAppleId: d.appAppleId } : {}),
        ...(d.tx ? { signedTransactionInfo: jws(d.tx) } : {}), ...(d.renewal ? { signedRenewalInfo: jws(d.renewal) } : {}),
      },
    }),
  };
}
