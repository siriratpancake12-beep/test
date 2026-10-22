import { sql, type Kysely } from "kysely";

/**
 * 账号、登录、进度、埋点的表。负责人:服务器主体(server-core)。
 * 其他模块的表在 billing.ts、ai.ts。迁移按 core → billing → ai 的顺序执行。
 *
 * 时间一律由服务器代码传入(deps.now()),不用数据库的 now():测试可以拨时钟,多台服务器也以同一种方式取时间。
 */
export interface CoreTables {
  users: {
    /** UUID v4:支付模块把它当作苹果内购的 appAccountToken,必须是 UUID */
    id: string;
    phone: string | null;
    apple_sub: string | null;
    /** 微信开放平台下的统一标识(有就优先用它认人) */
    wechat_unionid: string | null;
    /** 本 App 的微信 openid(拿不到 unionid 时用它认人) */
    wechat_openid: string | null;
    /** Sign in with Apple 的刷新令牌:注销账号时用它向苹果撤销授权(苹果要求);App 登录时带了授权码才有 */
    apple_refresh_token: string | null;
    created_at: Date;
    /**
     * 注销时间。注销后这一行只留 id 和时间(手机号、苹果/微信标识清空),
     * 用来让旧 token 失效、后台统计注册数;同一个手机号可以重新注册成新账号。
     */
    deleted_at: Date | null;
  };
  /** 短信验证码:只存哈希;同时用作限流记录(按手机号、按 IP 数条数),两天后清理 */
  sms_codes: {
    id: string;
    phone: string;
    code_hash: string;
    ip: string;
    created_at: Date;
    expires_at: Date;
    /** 已经验证过几次(对的错的都算) */
    attempts: number;
    used_at: Date | null;
  };
  /** 学习进度:每个用户每个语种一行。data 是 core 的 Progress(JSON),rev 每保存一次加一 */
  progress: {
    user_id: string;
    lang: string;
    /** null = 还没有上传过(并发写入时先占位的行) */
    data: unknown;
    rev: number;
    updated_at: Date;
  };
  /** 埋点(core 的 AppEvent)。id 由客户端生成,用来去重 */
  events: {
    id: string;
    /** 登录后上传的才有;注销账号时置空 */
    user_id: string | null;
    anon_id: string;
    name: string;
    /** 客户端记录的发生时间(离线学习、晚上传的,按真正学习的时间统计) */
    at: Date;
    /** 服务器收到的时间 */
    received_at: Date;
    lang: string | null;
    props: unknown;
    platform: string;
    app_version: string;
  };
}

export async function migrateCore(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("phone", "text", (c) => c.unique())
    .addColumn("apple_sub", "text", (c) => c.unique())
    .addColumn("wechat_unionid", "text", (c) => c.unique())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .execute();
  // 第一版建表之后加的列:已有的库(开发机上的 PGlite)也要补上
  await sql`alter table users add column if not exists wechat_openid text`.execute(db);
  await sql`alter table users add column if not exists apple_refresh_token text`.execute(db);
  await db.schema.createIndex("users_wechat_openid").ifNotExists().unique().on("users").column("wechat_openid").execute();
  // 后台按注册时间统计新用户和留存
  await db.schema.createIndex("users_created_at").ifNotExists().on("users").column("created_at").execute();

  await db.schema
    .createTable("sms_codes")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("phone", "text", (c) => c.notNull())
    .addColumn("code_hash", "text", (c) => c.notNull())
    .addColumn("ip", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("used_at", "timestamptz")
    .execute();
  await db.schema.createIndex("sms_codes_phone_created").ifNotExists().on("sms_codes").columns(["phone", "created_at"]).execute();
  await db.schema.createIndex("sms_codes_ip_created").ifNotExists().on("sms_codes").columns(["ip", "created_at"]).execute();
  await db.schema.createIndex("sms_codes_created").ifNotExists().on("sms_codes").column("created_at").execute();

  await db.schema
    .createTable("progress")
    .ifNotExists()
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("lang", "text", (c) => c.notNull())
    .addColumn("data", "jsonb")
    .addColumn("rev", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .addPrimaryKeyConstraint("progress_pkey", ["user_id", "lang"])
    .execute();

  await db.schema
    .createTable("events")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text")
    .addColumn("anon_id", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("at", "timestamptz", (c) => c.notNull())
    .addColumn("received_at", "timestamptz", (c) => c.notNull())
    .addColumn("lang", "text")
    .addColumn("props", "jsonb", (c) => c.notNull())
    .addColumn("platform", "text", (c) => c.notNull())
    .addColumn("app_version", "text", (c) => c.notNull())
    .execute();
  // 指标按"事件类型 + 时间段"查(周活跃、留存);按用户查(留存、北极星、注销时置空);
  // 按 anonId 把登录前的匿名事件对应到账号(周活跃去重)
  await db.schema.createIndex("events_name_at").ifNotExists().on("events").columns(["name", "at"]).execute();
  await db.schema.createIndex("events_user_at").ifNotExists().on("events").columns(["user_id", "at"]).execute();
  await db.schema.createIndex("events_anon").ifNotExists().on("events").column("anon_id").execute();
}
