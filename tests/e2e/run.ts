/**
 * 端到端测试:打包网页版,用真浏览器把主要流程走一遍。`npm run e2e`
 *
 * 1. 新用户:隐私同意(同意前本机什么都不记;不同意 → 说明 → 再看看;看隐私政策)→ 选语种 → 设目标 → 学习计划
 *    → 第一课 → 首页 → 周报 → 会员试用 → 第二课 → 复习 → 刷新后进度还在 → 设置页(没配服务器就没有登录)
 *    → 埋点只记 events.ts 列出的属性 → 撤回同意再同意,学习记录还在
 * 2. 学过一些的用户:分级测试 → 学习计划
 * 3. 冠词老出错的会员(同意的是旧版协议):先重新同意 → 首页出现弱点专练 → 专练只出冠词题
 * 4. 有服务器(本机的假服务器,320 宽的小屏):同意前不发任何请求 → 短信登录 → 进度和"旧手机"合并
 *    → 学完一课自动上传 → 切到后台上传埋点 → 登录过期自动退出 → 换账号要确认 → 注销账号回到第一次打开的状态
 *
 * 答题策略很笨(总选第一个、输入 Hallo),只验证流程走得通、不报错,不验证答对。
 * 本机已有 Chromium 时用 CHROMIUM_PATH 指定;CI 里用 `npx playwright install chromium`。
 */
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium, type Page } from "playwright";
import {
  applySubEvent, completeLesson, emptyDay, emptyProgress, EventsReq, Lesson, mergeProgress, ProgressPutReq, recordAnswer, ROUTES,
  SmsSendReq, SmsVerifyReq, type AppEvent, type Progress,
} from "../../packages/core/src/index";

const root = join(import.meta.dirname, "..", "..");
const dist = join(root, "apps", "mobile", "dist-web");
const shots = join(import.meta.dirname, "shots");
mkdirSync(shots, { recursive: true });
if (!existsSync(join(dist, "index.html"))) throw new Error("先运行 npm run build:web -w @lingo/mobile");
const readLesson = (f: string) => Lesson.parse(JSON.parse(readFileSync(join(root, "content", "courses", "de", f), "utf8")));

// ---- 假服务器:按 core/api.ts 的接口约定实现登录、进度、埋点、注销(只在内存里) ----
const CODE = "246810";
/** "平板"上学习的那天(测并发上传时用) */
const TABLET_DAY = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const mock = {
  requests: [] as { method: string; path: string; auth: string | null; status?: number }[],
  codes: new Map<string, string>(),
  /** 手机号 → 账号 */
  users: new Map<string, { id: string; token: string }>(),
  /** `${userId}:${lang}` → 进度 */
  progress: new Map<string, { progress: unknown; rev: number }>(),
  events: [] as AppEvent[],
  deleted: [] as string[],
  /** 下一次 GET 这份进度之后,模拟"平板"抢先上传了一版:App 带着旧的 baseRev 上传会收到 409 */
  interfere: null as string | null,
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}

async function mockApi(req: IncomingMessage, path: string): Promise<{ status: number; data?: unknown }> {
  const body = await readBody(req);
  const auth = req.headers.authorization ?? null;
  mock.requests.push({ method: req.method ?? "", path, auth });
  const fail = (status: number, code: string, message: string) => ({ status, data: { error: { code, message } } });
  const userOf = (phone: string) => ({ id: mock.users.get(phone)!.id, phone, hasApple: false, hasWechat: false, createdAt: "2026-10-01T00:00:00.000Z" });

  if (req.method === "POST" && path === ROUTES.smsSend) {
    const r = SmsSendReq.safeParse(body);
    if (!r.success) return fail(400, "invalid", "请输入正确的手机号");
    mock.codes.set(r.data.phone, CODE);
    return { status: 200, data: {} };
  }
  if (req.method === "POST" && path === ROUTES.smsVerify) {
    const r = SmsVerifyReq.safeParse(body);
    if (!r.success || mock.codes.get(r.data.phone) !== r.data.code) return fail(400, "bad_code", "验证码不对,请重新输入");
    const isNew = !mock.users.has(r.data.phone);
    if (isNew) mock.users.set(r.data.phone, { id: `u-${r.data.phone}`, token: `t-${r.data.phone}-${Date.now()}` });
    return { status: 200, data: { token: mock.users.get(r.data.phone)!.token, user: userOf(r.data.phone), isNew } };
  }
  if (req.method === "POST" && path === ROUTES.events) {
    const r = EventsReq.safeParse(body);
    if (!r.success) return fail(400, "invalid", r.error.issues[0]?.message ?? "格式不对");
    mock.events.push(...r.data.events);
    return { status: 200, data: { accepted: r.data.events.length } };
  }
  const user = [...mock.users.values()].find((u) => auth === `Bearer ${u.token}`);
  if (!user) return fail(401, "unauthorized", "登录已过期,请重新登录");
  const m = path.match(/^\/v1\/progress\/(\w+)$/);
  if (m) {
    const key = `${user.id}:${m[1]}`;
    const cur = mock.progress.get(key) ?? { progress: null, rev: 0 };
    if (req.method === "GET") {
      if (mock.interfere === key && cur.progress) {
        mock.interfere = null;
        const tablet = structuredClone(cur.progress) as Progress;
        tablet.log[TABLET_DAY] = { ...emptyDay(), seconds: 600, answers: 20, score: 18 };
        mock.progress.set(key, { progress: tablet, rev: cur.rev + 1 });
      }
      return { status: 200, data: cur };
    }
    if (req.method === "PUT") {
      const r = ProgressPutReq.safeParse(body);
      if (!r.success) return fail(400, "invalid", "格式不对");
      if (r.data.baseRev !== cur.rev) return fail(409, "conflict", "进度刚在别的设备上更新过");
      // 和真服务器一样按 core 的规则合并,不会丢掉别的设备的内容
      const merged = cur.progress ? mergeProgress(cur.progress as Progress, r.data.progress as Progress) : r.data.progress;
      const next = { progress: JSON.parse(JSON.stringify(merged)), rev: cur.rev + 1 };
      mock.progress.set(key, next);
      return { status: 200, data: next };
    }
  }
  if (req.method === "DELETE" && path === ROUTES.account) {
    for (const [phone, u] of mock.users) if (u.id === user.id) mock.users.delete(phone);
    for (const k of [...mock.progress.keys()]) if (k.startsWith(`${user.id}:`)) mock.progress.delete(k);
    mock.deleted.push(user.id);
    return { status: 204 };
  }
  return fail(404, "not_found", "找不到");
}

// 静态文件服务;找不到的路径回退到 index.html(单页应用)。/v1/ 开头的是假服务器(同源,不用处理跨域)
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  if (path.startsWith("/v1/")) {
    const { status, data } = await mockApi(req, path);
    mock.requests.at(-1)!.status = status;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data === undefined ? "" : JSON.stringify(data));
    return;
  }
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

function helpers(page: Page) {
  const click = async (text: string, exact = false) => {
    await page.getByText(text, { exact }).filter({ visible: true }).first().click();
    await page.waitForTimeout(300);
  };
  const tap = async (testId: string) => {
    await page.getByTestId(testId).filter({ visible: true }).first().click();
    await page.waitForTimeout(300);
  };
  const fill = (testId: string, text: string) => page.getByTestId(testId).filter({ visible: true }).first().fill(text);
  const visible = async (text: string) => (await page.getByText(text, { exact: true }).filter({ visible: true }).count()) > 0;
  const vis = (sel: string) => page.locator(sel).filter({ visible: true });
  const body = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  const storage = () => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  /** 本机埋点队列 */
  const queued = async () => JSON.parse((await storage())["analytics:queue"] ?? "[]") as AppEvent[];
  /** 等到条件成立(同步和上传都是异步的),最多 timeout 毫秒 */
  const until = async (fn: () => Promise<boolean> | boolean, timeout = 8000) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeout; await page.waitForTimeout(200)) if (await fn()) return true;
    return false;
  };
  /**
   * 模拟 App 切到后台 / 回到前台(网页版的 AppState 跟着 visibilitychange 走)。
   * 用字符串传给浏览器:tsx 编译时会给对象里的函数加 __name(),浏览器里没有这个函数
   */
  const setVisibility = (state: "hidden" | "visible") => page.evaluate(`(() => {
    const st = ${JSON.stringify(state)};
    Object.defineProperty(document, "visibilityState", { configurable: true, get() { return st; } });
    Object.defineProperty(document, "hidden", { configurable: true, get() { return st === "hidden"; } });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
  /** 看得见的元素有没有超出屏幕右边(小屏手机不能横向溢出) */
  const overflow = () => page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1;
  }).length);
  /** 页头有没有"返回"(撤回同意、注销后导航不能留下旧页面) */
  const canGoBack = async () => (await page.locator('[aria-label*="back"]').filter({ visible: true }).count()) > 0;
  /** 一直答题,直到出现结束页 */
  const answerAll = async (tag: string) => {
    for (let n = 1; n <= 60; n++) {
      await page.waitForTimeout(200);
      if ((await visible("🎉 学完了!")) || (await visible("专练完成")) || (await visible("复习完成")) || page.url().includes("plan")) return true;
      if (await visible("继续")) { await click("继续", true); continue; }
      if (await visible("我读完了")) { await click("我读完了"); continue; }
      if (await vis('[data-testid="answer-input"]').count()) {
        await vis('[data-testid="answer-input"]').first().fill("Hallo");
        await click("检查", true);
        continue;
      }
      const tiles = vis('[data-testid="tile"]');
      if (await tiles.count()) {
        const k = await tiles.count();
        for (let i = 0; i < k; i++) await tiles.nth(i).click();
        await click("检查", true);
        continue;
      }
      if (await vis('[data-testid="option"]').count()) { await vis('[data-testid="option"]').first().click(); continue; }
      await shot(`stuck-${tag}`);
      return false;
    }
    return false;
  };
  return { click, tap, fill, visible, body, shot, storage, queued, until, setVisibility, overflow, canGoBack, answerAll };
}

async function newPage(opts: { state?: Record<string, string>; apiBase?: string; width?: number } = {}) {
  const page = await browser.newPage({ viewport: { width: opts.width ?? 390, height: 844 } });
  page.on("pageerror", (e) => failures.push(`页面报错:${e.message}`));
  if (opts.state) await page.addInitScript((st) => { if (!localStorage.getItem("currentLang")) for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); }, opts.state);
  if (opts.apiBase) await page.addInitScript((b) => { (window as { __LINGO_API_BASE__?: string }).__LINGO_API_BASE__ = b; }, opts.apiBase);
  await page.goto(base);
  await page.waitForTimeout(1500);
  return page;
}

// ---- 1. 新用户 ----
{
  const page = await newPage();
  const { click, tap, body, shot, storage, queued, canGoBack, answerAll } = helpers(page);
  check((await body()).includes("欢迎使用语途") && (await body()).includes("《隐私政策》"), "第一次打开:先显示用户协议和隐私政策摘要");
  check(Object.keys(await storage()).length === 0, "同意之前本机什么都没记(没有埋点、没有任何记录)");
  await shot("00-consent");
  await tap("consent-decline");
  check((await body()).includes("需要你同意后才能使用") && page.url().endsWith("/consent"), "不同意:给出说明,不退出、不跳走");
  await tap("consent-review");
  await click("《隐私政策》", true);
  await page.waitForTimeout(500);
  check((await body()).includes("隐私政策") && page.url().includes("legal"), "同意前可以打开隐私政策");
  await page.goBack();
  await page.waitForTimeout(500);
  check(Object.keys(await storage()).length === 0, "看完协议、点过不同意,仍然什么都没记");
  await tap("consent-agree");
  await page.waitForTimeout(800);
  check((await body()).includes("你想学哪门语言"), "同意后进入原来的新用户引导");
  const consent = JSON.parse((await storage()).consent ?? "{}") as { version?: string; at?: string };
  check(!!consent.version && !!consent.at, "同意的版本和时间存在本机");
  const anonId = (await storage())["analytics:anonId"] ?? "";
  check(anonId.length >= 8 && (await queued()).map((e) => e.name).join() === "app_open", "同意后才生成 anonId,记下第一条 app_open");

  await click("德语 · Deutsch");
  await click("出国留学");
  await click("B1", true);
  await click("15 分钟");
  await click("1 年内");
  await click("零基础");
  await page.waitForTimeout(600);
  await shot("01-plan");
  check((await body()).includes("目标 B1") && (await body()).includes("每天需要学约"), "学习计划:显示目标,并提示按期需要的每日时间");
  await click("先免费学第一单元");
  await page.waitForTimeout(600);
  await click("新课:打招呼和自我介绍");
  await page.waitForTimeout(800);
  await click("学生词");
  await click("下一步");
  await click("开始练习");
  check(await answerAll("lesson1"), "第一课:练习做完");
  await shot("02-lesson-done");
  await click("回首页");
  await page.waitForTimeout(600);
  check((await body()).includes("连续 1 天"), "首页:连续 1 天");
  await click("📊 本周学习报告");
  await page.waitForTimeout(500);
  check((await body()).includes("能用德语跟人打招呼"), "周报:列出这周学会的事");
  await page.goBack();
  await page.waitForTimeout(500);
  await click("了解会员");
  await page.waitForTimeout(500);
  check((await body()).includes("扣费前 5 天和前 1 天都会提醒你"), "会员页:写明自动续费和提醒");
  await click("免费试用 7 天");
  await page.waitForTimeout(700);
  check((await body()).includes("试用有效期至"), "开通试用后首页显示试用期");
  await click("继续学下一课:我的家人");
  await page.waitForTimeout(800);
  await click("学生词");
  await click("下一步");
  await click("开始练习");
  check(await answerAll("lesson2"), "第二课(会员):练习做完");
  await click("回首页");
  await page.waitForTimeout(700);
  if (await page.getByText("复习", { exact: true }).filter({ visible: true }).count()) {
    await page.getByText("复习", { exact: true }).filter({ visible: true }).first().click();
    await page.waitForTimeout(600);
    check(await answerAll("review"), "复习做完");
    await click("回首页");
    await page.waitForTimeout(900);
  }
  const before = (await body()).slice(0, 150);
  await page.reload();
  await page.waitForTimeout(1500);
  check((await body()).slice(0, 150) === before, "刷新后进度还在");
  await shot("03-home");

  // 设置页:没配服务器时没有登录入口;注销、协议、版本都在
  await click("⚙️ 设置", true);
  await page.waitForTimeout(600);
  const settings = await body();
  await shot("03b-settings");
  check(["学习提醒", "试用中", "恢复购买", "用户协议", "自动续费服务规则", "第三方 SDK 清单", "撤回隐私政策同意", "版本 1.0.0"].every((t) => settings.includes(t)), "设置页:目标、提醒、会员、协议、版本都在");
  check(!settings.includes("登录"), "没配服务器:不出现登录入口");

  // 埋点:只在本机排队(没配服务器),只有 events.ts 列出的属性
  const names = (await queued()).map((e) => e.name);
  check(["onboarding_complete", "plan_view", "lesson_start", "lesson_complete", "report_view", "paywall_view", "trial_start"].every((n) => names.includes(n)), "埋点:各页面的事件都记下了");
  const done = (await queued()).find((e) => e.name === "lesson_complete");
  check(!!done && typeof done.props.seconds === "number" && Object.keys(done.props).sort().join() === "correct,lessonId,seconds,total", "埋点:lesson_complete 带用时,不带多余属性");
  // 第一条 app_open 在选语种之前,没有 lang
  check((await queued()).every((e) => e.anonId === anonId && (e.name === "app_open" || e.lang === "de")), "埋点:都带同一个 anonId 和语种");

  // 撤回同意:回到同意页、删掉埋点数据;本机的学习记录保留
  await page.getByTestId("settings-withdraw").click();
  await page.getByTestId("confirm-action").click();
  await page.waitForTimeout(800);
  const st = await storage();
  check((await body()).includes("欢迎使用语途") && !st["analytics:queue"] && !st["analytics:anonId"] && !st.consent, "撤回同意:回到同意页,本机的埋点数据删掉了");
  await tap("consent-agree");
  await page.waitForTimeout(900);
  check((await body()).includes("连续 1 天") && (await storage())["analytics:anonId"] !== anonId, "重新同意:学习记录还在,anonId 是新的");
  check(!(await canGoBack()), "重新同意后回到首页,没有残留的返回");

  // ---- 2. 学过一些:分级测试 ----
  await click("换一门语言");
  await page.waitForTimeout(700);
  await click("法语 · Français");
  await click("旅行");
  await click("A2", true);
  await click("30 分钟");
  await click("没有期限");
  await click("学过一些");
  await page.waitForTimeout(700);
  check((await body()).includes("分级测试") || (await body()).includes("第 1/"), "分级测试开始");
  await answerAll("placement");
  await page.waitForTimeout(700);
  check((await body()).includes("目标 A2"), "分级测试后进入学习计划");
  check((await queued()).some((e) => e.name === "placement_complete" && e.lang === "fr" && typeof e.props.questions === "number"), "埋点:分级测试结果");
  await page.close();
}

// ---- 3. 冠词老出错的会员(同意的是旧版协议)----
{
  const now = new Date();
  let p: Progress = { ...emptyProgress("de", -now.getTimezoneOffset()), goal: { kind: "study-abroad", target: "A2", dailyMinutes: 15 } };
  p = completeLesson(p, readLesson("a1u1.l01.json"), now);
  p = completeLesson(p, readLesson("a1u1.l02.json"), now);
  for (const id of ["de.mutter", "de.schwester", "de.kind"]) {
    p = recordAnswer(p, { itemId: id, direction: "produce", verdict: "wrong", issues: [{ kind: "article", expected: "die", got: "der" }] }, now);
  }
  const sub = applySubEvent(null, { type: "start-trial", productId: "premium_yearly", platform: "web", at: now });
  const page = await newPage({ state: {
    currentLang: "de", "progress:de": JSON.stringify(p), subscription: JSON.stringify(sub),
    consent: JSON.stringify({ version: "2000-01-01", at: "2000-01-01T00:00:00.000Z" }),
  } });
  const { body, shot, tap } = helpers(page);
  check((await body()).includes("协议更新了"), "协议改版后重新征求同意");
  await tap("consent-agree");
  await page.waitForTimeout(800);
  check((await body()).includes("弱点专练:冠词/名词的性"), "首页:出现冠词弱点专练");
  check(!(await body()).includes("欢迎回来"), "刚学过的人不会被当成'回归'");
  await page.getByText(/弱点专练/).filter({ visible: true }).first().click();
  await page.waitForTimeout(800);
  const options = await page.locator('[data-testid="option"]').filter({ visible: true }).allInnerTexts();
  check(JSON.stringify(options) === JSON.stringify(["der", "die", "das"]), "弱点专练:出的是选冠词题");
  await shot("04-drill");
  await page.close();
}

// ---- 4. 有服务器:登录、同步、埋点上传、注销 ----
{
  // "旧手机"上学过第一课、目标 A2:登录后要合并到新手机上
  const PHONE = "13800138000";
  const yesterday = new Date(Date.now() - 86_400_000);
  let old = { ...emptyProgress("de", -yesterday.getTimezoneOffset()), goal: { kind: "travel" as const, target: "A2" as const, dailyMinutes: 20 } };
  old = completeLesson(old, readLesson("a1u1.l01.json"), yesterday);
  old = recordAnswer(old, { itemId: "de.hallo", direction: "produce", verdict: "correct", ms: 3000 }, yesterday);
  mock.users.set(PHONE, { id: "u-old", token: "t-old" });
  mock.progress.set("u-old:de", { progress: JSON.parse(JSON.stringify(old)), rev: 3 });
  // 服务器上一份坏掉的英语进度:App 要忽略它,不能崩
  mock.progress.set("u-old:en", { progress: { lang: "en", cards: { x: { card: { due: "坏数据" } } } }, rev: 1 });

  const page = await newPage({ apiBase: base.slice(0, -1), width: 320 });
  const { click, tap, fill, body, shot, storage, until, setVisibility, overflow, canGoBack, answerAll } = helpers(page);
  check(mock.requests.length === 0, "有服务器:同意之前一个请求都不发");
  check((await overflow()) === 0, "同意页:320 宽不超出屏幕");
  await tap("consent-agree");
  await page.waitForTimeout(800);
  await click("德语 · Deutsch");
  await click("出国留学");
  await click("B1", true);
  await click("15 分钟");
  await click("1 年内");
  await click("零基础");
  await page.waitForTimeout(600);
  await click("先免费学第一单元");
  await page.waitForTimeout(600);
  check((await body()).includes("登录后换手机不丢进度"), "首页:没登录时提示登录的好处(不强迫)");
  check(!mock.requests.some((r) => r.path.startsWith("/v1/progress")), "没登录不同步");

  await click("⚙️ 设置", true);
  await page.waitForTimeout(600);
  check((await overflow()) === 0, "设置页:320 宽不超出屏幕");
  await tap("settings-login");
  await page.waitForTimeout(600);
  await shot("05-login");
  check((await overflow()) === 0, "登录页:320 宽不超出屏幕");
  await fill("phone-input", "1380013800");
  await tap("send-code");
  check((await body()).includes("请输入正确的手机号") && !mock.requests.some((r) => r.path === ROUTES.smsSend), "登录:手机号格式不对,本机就拦下");
  await fill("phone-input", `+86 ${PHONE}`);
  await tap("send-code");
  await page.waitForTimeout(500);
  check(mock.codes.has(PHONE) && /\d+ 秒后重发/.test(await body()), "登录:去掉 +86 后发出验证码,开始 60 秒倒计时");
  await fill("code-input", "000000");
  await tap("login-submit");
  await page.waitForTimeout(500);
  check((await body()).includes("验证码不对,请重新输入"), "登录:验证码错了显示服务器给的中文提示");
  await fill("code-input", CODE);
  await tap("login-submit");
  await page.waitForTimeout(800);
  check((await body()).includes("手机号 138****8000"), "登录成功,回到设置页显示账号");
  const synced = await until(async () => {
    const pr = JSON.parse((await storage())["progress:de"] ?? "{}") as Progress;
    return !!pr.completed?.["de.a1u1.l01"] && pr.goal?.target === "A2";
  });
  check(synced, "登录后同步:旧手机学过的课和目标合并进来");
  check(mock.requests.every((r) => !r.path.startsWith("/v1/progress") || r.auth === "Bearer t-old"), "同步请求带着登录凭证");
  check(await until(() => mock.requests.some((r) => r.path === ROUTES.progress("en"))) && !(await storage())["progress:en"], "服务器上的坏数据被忽略,不写进本机");
  await page.goBack();
  await page.waitForTimeout(800);
  check((await body()).includes("新课:我的家人"), "首页:按合并后的进度安排下一课(复习卡的日期正确还原)");

  // 在新手机上学完第二课:3 秒内自动上传。上传前"平板"刚好也传了一版(409),要重新合并后再传
  await click("新课:我的家人");
  await page.waitForTimeout(800);
  await click("学生词");
  await click("下一步");
  await click("开始练习");
  check(await answerAll("server-lesson2"), "新手机上学完第二课");
  mock.interfere = "u-old:de";
  await click("回首页");
  const uploaded = await until(() => {
    const pr = mock.progress.get("u-old:de")?.progress as Progress | undefined;
    return !!pr?.completed["de.a1u1.l02"] && !!pr.completed["de.a1u1.l01"] && !!pr.log[TABLET_DAY];
  });
  check(uploaded && mock.requests.some((r) => r.status === 409), "学完一课后自动上传;和平板同时上传(409)时重新合并,三台设备的记录都在");
  check(await until(async () => !!(JSON.parse((await storage())["progress:de"] ?? "{}") as Progress).log?.[TABLET_DAY]), "采用服务器合并后的版本:平板的学习记录也到了这台手机");

  // 切到后台:上传埋点
  await setVisibility("hidden");
  check(await until(() => mock.events.some((e) => e.name === "lesson_complete")), "切到后台时上传埋点");
  await setVisibility("visible");
  const names = mock.events.map((e) => e.name);
  check(names[0] === "app_open" && ["onboarding_complete", "plan_view", "login", "lesson_start", "lesson_complete"].every((n) => names.includes(n)), "上传的埋点从同意后的 app_open 开始,各事件都在");
  check(mock.events.find((e) => e.name === "login")?.props.isNew === false && new Set(mock.events.map((e) => e.anonId)).size === 1, "埋点:login 带 isNew,全程同一个 anonId");
  await page.waitForTimeout(500);
  check(JSON.parse((await storage())["analytics:queue"] ?? "[]").length === 0, "上传成功的埋点从本机队列删掉");

  // 登录过期(服务器不认这个凭证了):本机自动退出,设置页提示
  mock.users.set(PHONE, { id: "u-old", token: "t-old-2" });
  await setVisibility("hidden");
  await setVisibility("visible");
  const loggedOut = await until(async () => !(await storage()).session, 10000);
  await click("⚙️ 设置", true);
  await page.waitForTimeout(600);
  check(loggedOut && (await body()).includes("登录已过期,请重新登录"), "登录过期:回到前台同步时发现,本机退出登录并提示");

  // 换一个账号登录:本机记录属于别人,要先确认
  const login = async (phone: string) => {
    await tap("settings-login");
    await page.waitForTimeout(500);
    await fill("phone-input", phone);
    await tap("send-code");
    await page.waitForTimeout(300);
    await fill("code-input", CODE);
    await tap("login-submit");
    await page.waitForTimeout(800);
  };
  await login("13900139000");
  check((await body()).includes("这台设备上有另一个账号的学习记录"), "换账号登录:先确认,不把两个人的进度混在一起");
  await click("取消", true);
  await page.goBack();
  await page.waitForTimeout(600);
  check(!(await storage()).session && JSON.parse((await storage())["progress:de"] ?? "{}").completed?.["de.a1u1.l02"], "取消换账号:没登录,本机记录不动");

  // 登回原来的账号,然后注销
  await login(PHONE);
  check((await body()).includes("手机号 138****8000"), "登回原来的账号不用确认");
  await tap("settings-delete");
  await shot("06-delete-confirm");
  check((await body()).includes("永久删除"), "注销账号:二次确认,说清楚后果");
  await tap("confirm-action");
  await until(async () => (await body()).includes("欢迎使用语途"), 10000);
  check(mock.deleted.includes("u-old"), "注销:服务器删除账号");
  const left = Object.keys(await storage());
  check((await body()).includes("欢迎使用语途") && left.length === 0, `注销后回到第一次打开的状态,本机数据清空(剩下:${left.join(",") || "无"})`);
  check(mock.events.some((e) => e.name === "account_delete"), "注销前把最后的埋点传上去");
  await tap("consent-agree");
  await page.waitForTimeout(800);
  check((await body()).includes("你想学哪门语言") && !(await canGoBack()), "注销后重新同意:从新用户引导开始,没有残留的页面");
  await page.close();
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`\n${failures.length} 项失败:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\n全部通过");
