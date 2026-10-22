/**
 * 支付校验:App Store(和以后的安卓渠道)交易、服务器通知 → 订阅事件(core 的 SubEvent)。
 * 负责人:billing。服务器的 routes/billing.ts 通过 AppStoreVerifier 接口调用,测试里可以换成假的。
 * 接入步骤、App Store Connect 设置见 docs/08-支付接入.md。
 */
export * from "./types";
export * from "./state";
export * from "./apple-events";
export * from "./apple";
