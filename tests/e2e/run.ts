/**
 * 端到端测试:打包网页版,用真浏览器把主要流程走一遍。`npm run e2e`
 *
 * 1. 新用户:选语种 → 设目标 → 学习计划 → 第一课 → 首页 → 周报 → 会员试用 → 第二课 → 复习 → 刷新后进度还在
 * 2. 学过一些的用户:分级测试 → 学习计划
 * 3. 冠词老出错的会员:首页出现弱点专练 → 专练只出冠词题
 *
 * 答题策略很笨(总选第一个、输入 Hallo),只验证流程走得通、不报错,不验证答对。
 * 本机已有 Chromium 时用 CHROMIUM_PATH 指定;CI 里用 `npx playwright install chromium`。
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium, type Page } from "playwright";
import { applySubEvent, completeLesson, emptyProgress, Lesson, recordAnswer, type Progress } from "../../packages/core/src/index";

const root = join(import.meta.dirname, "..", "..");
const dist = join(root, "apps", "mobile", "dist-web");
const shots = join(import.meta.dirname, "shots");
mkdirSync(shots, { recursive: true });
if (!existsSync(join(dist, "index.html"))) throw new Error("先运行 npm run build:web -w @lingo/mobile");

// 静态文件服务;找不到的路径回退到 index.html(单页应用)
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf" };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
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
  const visible = async (text: string) => (await page.getByText(text, { exact: true }).filter({ visible: true }).count()) > 0;
  const vis = (sel: string) => page.locator(sel).filter({ visible: true });
  const body = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
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
  return { click, visible, body, shot, answerAll };
}

async function newPage(state?: Record<string, string>) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => failures.push(`页面报错:${e.message}`));
  if (state) await page.addInitScript((st) => { if (!localStorage.getItem("currentLang")) for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); }, state);
  await page.goto(base);
  await page.waitForTimeout(1500);
  return page;
}

// ---- 1. 新用户 ----
{
  const page = await newPage();
  const { click, body, shot, answerAll } = helpers(page);
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
  await page.close();
}

// ---- 3. 冠词老出错的会员 ----
{
  const read = (f: string) => Lesson.parse(JSON.parse(readFileSync(join(root, "content", "courses", "de", f), "utf8")));
  const now = new Date();
  let p: Progress = { ...emptyProgress("de", -now.getTimezoneOffset()), goal: { kind: "study-abroad", target: "A2", dailyMinutes: 15 } };
  p = completeLesson(p, read("a1u1.l01.json"), now);
  p = completeLesson(p, read("a1u1.l02.json"), now);
  for (const id of ["de.mutter", "de.schwester", "de.kind"]) {
    p = recordAnswer(p, { itemId: id, direction: "produce", verdict: "wrong", issues: [{ kind: "article", expected: "die", got: "der" }] }, now);
  }
  const sub = applySubEvent(null, { type: "start-trial", productId: "premium_yearly", platform: "web", at: now });
  const page = await newPage({ currentLang: "de", "progress:de": JSON.stringify(p), subscription: JSON.stringify(sub) });
  const { body, shot } = helpers(page);
  check((await body()).includes("弱点专练:冠词/名词的性"), "首页:出现冠词弱点专练");
  check(!(await body()).includes("欢迎回来"), "刚学过的人不会被当成'回归'");
  await page.getByText(/弱点专练/).filter({ visible: true }).first().click();
  await page.waitForTimeout(800);
  const options = await page.locator('[data-testid="option"]').filter({ visible: true }).allInnerTexts();
  check(JSON.stringify(options) === JSON.stringify(["der", "die", "das"]), "弱点专练:出的是选冠词题");
  await shot("04-drill");
  await page.close();
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`\n${failures.length} 项失败:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\n全部通过");
