import { Phone } from "@lingo/core";

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
  /**
   * 信任哪些代理转发来的 X-Forwarded-For(传给 Fastify 的 trustProxy,决定 req.ip)。
   * 服务器在负载均衡后面时,TCP 连接来自负载均衡,真实 IP 在 X-Forwarded-For 里;但这个头客户端可以随便填,
   * 所以只信"我们自己的代理"。默认:本机和内网地址段(含阿里云负载均衡用的 100.64.0.0/10),公网直连伪造的不算。
   * TRUST_PROXY:逗号分隔的 IP / 网段;true = 全信(只在服务器绝对不可能被直连时用);false = 不信;数字 = 信最近 N 跳。
   */
  trustProxy: boolean | number | string[];
  sms: {
    provider: "dev" | "aliyun"; aliyunAccessKeyId?: string; aliyunAccessKeySecret?: string; signName?: string; templateCode?: string;
    /** 扣费前提醒的短信模板 CODE(SMS_RENEWAL_TEMPLATE_CODE);不配就不发扣费前短信(见 jobs/renewal-sms.ts) */
    renewalTemplateCode?: string;
  };
  /**
   * 审核专用账号(App Store 和安卓商店审核时要能登录):这个手机号点"获取验证码"不发短信,验证码固定。
   * REVIEW_PHONE、REVIEW_CODE 两个都配了才开,默认关闭。除了不发短信,有效期、错 5 次作废、限流都和普通手机号一样。
   */
  review: { phone: string; code: string } | null;
  /**
   * 服务器里的定时任务(按保存期限清理数据、扣费前短信提醒),默认开。多台服务器同时开也只有一台在跑(jobs/runner.ts)。
   * JOBS_ENABLED=false:不在服务器里跑,改用 npm run purge / npm run renewal-sms 由外部定时调用。
   */
  jobs: { enabled: boolean };
  apple: {
    bundleId: string;
    appAppleId?: number;
    /** App Store Server API(内购)的密钥 */
    issuerId?: string;
    keyId?: string;
    privateKey?: string;
    environment: "Production" | "Sandbox" | "LocalTesting";
    /** Sign in with Apple 的密钥(和内购密钥不是同一把),用于换取令牌和注销时撤销授权 */
    teamId?: string;
    signInKeyId?: string;
    signInPrivateKey?: string;
    /** 苹果根证书(.cer)所在目录,校验内购交易和服务器通知的签名用(证书不进仓库) */
    rootCertsDir?: string;
  };
  wechat: { appId?: string; appSecret?: string };
  ai: { baseUrl?: string; apiKey?: string; model?: string; dailyFree: number; dailyPremium: number };
  speech: { provider: "none" | "azure"; azureKey?: string; azureRegion?: string };
}

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

/** 默认信任的代理地址:本机、链路本地、内网地址段(proxy-addr 的写法),加上运营商级 NAT 段(阿里云负载均衡转发到后端用它) */
export const DEFAULT_TRUST_PROXY = ["loopback", "linklocal", "uniquelocal", "100.64.0.0/10"];

export function parseTrustProxy(v: string | undefined): boolean | number | string[] {
  const s = (v ?? "").trim();
  if (!s) return DEFAULT_TRUST_PROXY;
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off|none)$/i.test(s)) return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * 太容易猜的固定验证码(六位一样、顺子)不让用:审核手机号要写进提交给各家商店的审核备注,不算绝对保密,
 * 知道号码的人会先试 000000、123456。
 */
export function weakCode(code: string): boolean {
  return /^(\d)\1{5}$/.test(code) || "01234567890".includes(code) || "09876543210".includes(code);
}

/** 审核账号:两个变量都配了才开;只配了一个就不开并提醒;配了但格式不对直接启动失败(免得审核时才发现登录不了) */
export function parseReviewAccount(phone: string | undefined, code: string | undefined, mode: Config["env"]): Config["review"] {
  const p = phone?.trim() ?? "";
  const c = code?.trim() ?? "";
  if (!p && !c) return null;
  if (!p || !c) {
    if (mode !== "test") console.warn("[登录] 审核账号没有开启:REVIEW_PHONE 和 REVIEW_CODE 要一起配置");
    return null;
  }
  if (!Phone.safeParse(p).success) throw new Error("REVIEW_PHONE 必须是 11 位中国大陆手机号");
  if (!/^\d{6}$/.test(c)) throw new Error("REVIEW_CODE 必须是 6 位数字");
  if (weakCode(c)) throw new Error("REVIEW_CODE 太容易猜(000000、123456 这类),请换一个随机的 6 位数");
  return { phone: p, code: c };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const cfg: Config = {
    port: num(env.PORT, 8080),
    databaseUrl: env.DATABASE_URL || null,
    pgliteDir: env.PGLITE_DIR || "./data/pglite",
    jwtSecret: env.JWT_SECRET || "dev-only-secret-change-me",
    adminToken: env.ADMIN_TOKEN || null,
    env: mode,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sms: {
      provider: env.SMS_PROVIDER === "aliyun" ? "aliyun" : "dev",
      aliyunAccessKeyId: env.ALIYUN_ACCESS_KEY_ID,
      aliyunAccessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
      signName: env.SMS_SIGN_NAME,
      templateCode: env.SMS_TEMPLATE_CODE,
      renewalTemplateCode: env.SMS_RENEWAL_TEMPLATE_CODE?.trim() || undefined,
    },
    review: parseReviewAccount(env.REVIEW_PHONE, env.REVIEW_CODE, mode),
    jobs: { enabled: !/^(false|no|off|0)$/i.test((env.JOBS_ENABLED ?? "").trim()) },
    apple: {
      bundleId: env.APPLE_BUNDLE_ID || "com.example.lingocn",
      appAppleId: env.APPLE_APP_ID ? Number(env.APPLE_APP_ID) : undefined,
      issuerId: env.APPLE_ISSUER_ID,
      keyId: env.APPLE_KEY_ID,
      privateKey: env.APPLE_PRIVATE_KEY,
      environment: env.APPLE_ENVIRONMENT === "Production" ? "Production" : env.APPLE_ENVIRONMENT === "LocalTesting" ? "LocalTesting" : "Sandbox",
      teamId: env.APPLE_TEAM_ID,
      signInKeyId: env.APPLE_SIGNIN_KEY_ID,
      signInPrivateKey: env.APPLE_SIGNIN_PRIVATE_KEY,
      rootCertsDir: env.APPLE_ROOT_CERTS_DIR || undefined,
    },
    wechat: { appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET },
    ai: { baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL, dailyFree: num(env.AI_DAILY_FREE, 12), dailyPremium: num(env.AI_DAILY_PREMIUM, 60) },
    speech: { provider: env.SPEECH_PROVIDER === "azure" ? "azure" : "none", azureKey: env.AZURE_SPEECH_KEY, azureRegion: env.AZURE_SPEECH_REGION },
  };
  if (cfg.env === "production") {
    if (cfg.jwtSecret === "dev-only-secret-change-me") throw new Error("生产环境必须设置 JWT_SECRET");
    if (cfg.sms.provider === "dev") throw new Error("生产环境不能用开发短信(SMS_PROVIDER)");
    // 不配就会悄悄用内置的 PGlite:数据存在容器里,重新部署就全没了
    if (!cfg.databaseUrl) throw new Error("生产环境必须设置 DATABASE_URL(内置的 PGlite 只用于开发和测试)");
  }
  return cfg;
}

export const testConfig = (over: Partial<Config> = {}): Config => ({ ...loadConfig({ NODE_ENV: "test" }), pgliteDir: "memory://", ...over });
