/**
 * 服务器配置,全部来自环境变量。密钥只放在服务器环境变量里,不进代码仓库、不下发给 App。
 * 没配的服务自动降级:没有数据库地址用内置 PGlite(本机文件);没有短信服务商就把验证码打在日志里(仅开发)。
 */
export interface Config {
  port: number;
  /** postgres://…;不填用 PGlite(开发、测试) */
  databaseUrl: string | null;
  /** PGlite 数据目录;"memory://" 表示只在内存里(测试) */
  pgliteDir: string;
  jwtSecret: string;
  /** 后台接口的口令(请求头 x-admin-token) */
  adminToken: string | null;
  /** production 时不允许开发用的短信、默认密钥等 */
  env: "development" | "test" | "production";
  sms: { provider: "dev" | "aliyun"; aliyunAccessKeyId?: string; aliyunAccessKeySecret?: string; signName?: string; templateCode?: string };
  apple: { bundleId: string; appAppleId?: number; issuerId?: string; keyId?: string; privateKey?: string; environment: "Production" | "Sandbox" | "LocalTesting" };
  wechat: { appId?: string; appSecret?: string };
  ai: { baseUrl?: string; apiKey?: string; model?: string; dailyFree: number; dailyPremium: number };
  speech: { provider: "none" | "azure"; azureKey?: string; azureRegion?: string };
}

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const cfg: Config = {
    port: num(env.PORT, 8080),
    databaseUrl: env.DATABASE_URL || null,
    pgliteDir: env.PGLITE_DIR || "./data/pglite",
    jwtSecret: env.JWT_SECRET || "dev-only-secret-change-me",
    adminToken: env.ADMIN_TOKEN || null,
    env: mode,
    sms: {
      provider: env.SMS_PROVIDER === "aliyun" ? "aliyun" : "dev",
      aliyunAccessKeyId: env.ALIYUN_ACCESS_KEY_ID,
      aliyunAccessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
      signName: env.SMS_SIGN_NAME,
      templateCode: env.SMS_TEMPLATE_CODE,
    },
    apple: {
      bundleId: env.APPLE_BUNDLE_ID || "com.example.lingocn",
      appAppleId: env.APPLE_APP_ID ? Number(env.APPLE_APP_ID) : undefined,
      issuerId: env.APPLE_ISSUER_ID,
      keyId: env.APPLE_KEY_ID,
      privateKey: env.APPLE_PRIVATE_KEY,
      environment: env.APPLE_ENVIRONMENT === "Production" ? "Production" : env.APPLE_ENVIRONMENT === "LocalTesting" ? "LocalTesting" : "Sandbox",
    },
    wechat: { appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET },
    ai: { baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL, dailyFree: num(env.AI_DAILY_FREE, 3), dailyPremium: num(env.AI_DAILY_PREMIUM, 60) },
    speech: { provider: env.SPEECH_PROVIDER === "azure" ? "azure" : "none", azureKey: env.AZURE_SPEECH_KEY, azureRegion: env.AZURE_SPEECH_REGION },
  };
  if (cfg.env === "production") {
    if (cfg.jwtSecret === "dev-only-secret-change-me") throw new Error("生产环境必须设置 JWT_SECRET");
    if (cfg.sms.provider === "dev") throw new Error("生产环境不能用开发短信(SMS_PROVIDER)");
  }
  return cfg;
}

export const testConfig = (over: Partial<Config> = {}): Config => ({ ...loadConfig({ NODE_ENV: "test" }), pgliteDir: "memory://", ...over });
