/**
 * 生成「语途」的图标和启动图:先用代码画 SVG,再用 Chromium(Playwright)渲染成 PNG,
 * 覆盖 apps/mobile/assets/ 下的同名文件(文件名不变,app.json 的引用不用改)。
 *
 *   在仓库根目录运行:
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium npx tsx apps/mobile/scripts/gen-icons.mts
 *
 *   --out <目录>    先输出到别的目录看效果(默认直接覆盖 apps/mobile/assets)
 *   --preview       同时输出 preview.png:各种尺寸、安卓遮罩、单色主题、启动图的效果一览
 *   --store <目录>  另外输出商店用的 512/216 图标和全部 SVG 源文件(不进仓库)
 *
 * 图形:一条从脚下延伸向远方的路(途、前进),路的尽头是一个对话气泡(语言、开口说——
 * 学外语的目的地)。全部是代码算出来的几何图形,没有用任何字体、图片或外部素材,版权干净。
 * 改颜色或形状只改下面的 COLOR / ROAD / BUBBLE,然后重新运行。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const ASSETS = join(import.meta.dirname, "..", "assets");

/** 品牌色:蓝色和 App 的主色(theme.ts 的 primary #3355FF)同一色系;黄色只用在"目的地"上 */
const COLOR = {
  bgTop: "#5C7CFF",
  bgBottom: "#2A3AD4",
  road: "#FFFFFF",
  bubble: "#FFC93C",
};

type Pt = [number, number];

/**
 * 路的中线:一段三次贝塞尔曲线(S 形,由近到远),坐标是 1024×1024 的图标画布。
 * 起点放在画布下方很远的地方:图标里看起来路是从画面外延伸进来的,
 * 缩小放进安卓自适应图标时(见 ADAPTIVE_SCALE)路也不会在画面里断掉。
 */
const ROAD = {
  p0: [470, 1420] as Pt,
  p1: [450, 1050] as Pt,
  p2: [860, 880] as Pt,
  p3: [522, 618] as Pt,
  /** 近处(起点)和远处(终点)的路宽:近大远小,像透视 */
  w0: 760,
  w1: 14,
};

/** 对话气泡:圆角矩形 + 指向路尽头的尾巴 + 三个点(正在说话) */
const BUBBLE = { x: 322, y: 232, w: 380, h: 272, r: 120, tipX: 522, tipY: 620 };

/** 安卓自适应图标:内容缩进安全区(108dp 画布中直径 66dp 的圆) */
const ADAPTIVE_SCALE = 0.64;

// ---------- 几何 ----------

function bez(t: number): Pt {
  const { p0, p1, p2, p3 } = ROAD;
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

function normalAt(t: number): Pt {
  const { p0, p1, p2, p3 } = ROAD;
  const u = 1 - t;
  const x = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
  const y = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
  const len = Math.hypot(x, y) || 1;
  return [-y / len, x / len];
}

/** 近处宽得快、远处窄得慢 */
const widthAt = (t: number) => ROAD.w1 + (ROAD.w0 - ROAD.w1) * Math.pow(1 - t, 1.35);

interface Sample { p: Pt; n: Pt; w: number }
const centerline = (steps: number): Sample[] =>
  Array.from({ length: steps + 1 }, (_, i) => i / steps).map((t) => ({ p: bez(t), n: normalAt(t), w: widthAt(t) }));

const f = (v: number) => (Math.round(v * 10) / 10).toString();
const pts = (list: Pt[]) => list.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join(" ");

/**
 * 路面:沿中线排一串圆(半径 = 路宽的一半),合在一起就是路。
 * 不用"左右两条边线"围成多边形:路很宽、弯又急的地方,内侧边线会折出尖角。
 */
const roadCircles = () => centerline(900).map(({ p, w }) => `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${f(w / 2)}"/>`).join("");

/** 路中间的虚线:每段的长短、粗细跟着路宽变(越远越小);快到尽头时不画,免得糊成一团 */
function dashPaths(): string {
  const s = centerline(1600);
  const out: string[] = [];
  const band = (seg: Sample[]) => {
    const left = seg.map(({ p, n, w }): Pt => [p[0] + n[0] * w * 0.045, p[1] + n[1] * w * 0.045]);
    const right = seg.map(({ p, n, w }): Pt => [p[0] - n[0] * w * 0.045, p[1] - n[1] * w * 0.045]).reverse();
    return `${pts([...left, ...right])} Z`;
  };
  let acc = 0, on = true, cur: Sample[] = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!;
    if (b.p[1] < 700) break;
    acc += Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
    if (on) cur.push(b);
    if (acc >= (on ? 0.34 : 0.3) * b.w) {
      if (on && cur.length > 1) out.push(band(cur));
      cur = [];
      acc = 0;
      on = !on;
    }
  }
  return out.join(" ");
}

/** 气泡轮廓(顺时针);尾巴两边向里弯,尖端落在路的尽头 */
function bubblePath(): string {
  const { x, y, w, h, r, tipX, tipY } = BUBBLE;
  const bottom = y + h;
  return [
    `M${x + r} ${y}`, `H${x + w - r}`, `A${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V${bottom - r}`, `A${r} ${r} 0 0 1 ${x + w - r} ${bottom}`,
    `H${tipX + 48}`, `Q${tipX + 22} ${bottom + 50} ${tipX} ${tipY}`, `Q${tipX - 22} ${bottom + 50} ${tipX - 48} ${bottom}`,
    `H${x + r}`, `A${r} ${r} 0 0 1 ${x} ${bottom - r}`, `V${y + r}`, `A${r} ${r} 0 0 1 ${x + r} ${y}`, "Z",
  ].join(" ");
}

function bubbleDots(): string {
  const { x, y, w, h } = BUBBLE;
  return [-1, 0, 1].map((k) => `<circle cx="${f(x + w / 2 + k * w * 0.2)}" cy="${f(y + h / 2)}" r="${f(h * 0.075)}"/>`).join("");
}

// ---------- 组装 SVG ----------

const S = 1024;
const svg = (size: number, body: string, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${S} ${S}"><defs>${defs}</defs>${body}</svg>`;
const scaled = (k: number, inner: string) =>
  `<g transform="translate(${S / 2} ${S / 2}) scale(${k}) translate(${-S / 2} ${-S / 2})">${inner}</g>`;

/** 背景:由上到下的蓝色渐变,气泡后面有一点亮光(远方的天光) */
const bgDefs = `
  <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="${COLOR.bgTop}"/><stop offset="1" stop-color="${COLOR.bgBottom}"/>
  </linearGradient>
  <radialGradient id="glow" cx="${BUBBLE.x + BUBBLE.w / 2}" cy="${BUBBLE.y + BUBBLE.h / 2}" r="520" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.26"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>`;
const background = `<rect width="${S}" height="${S}" fill="url(#bg)"/><rect width="${S}" height="${S}" fill="url(#glow)"/>`;

/** 图形本体。mono=true 时路和气泡同一种颜色(单色图标、通知图标);虚线和三个点都是镂空的 */
function mark(mono: boolean) {
  const big = `x="-2000" y="-2000" width="6000" height="6000"`;
  const defs = `
    <mask id="roadMask" maskUnits="userSpaceOnUse" ${big}>
      <rect ${big} fill="black"/><g fill="white">${roadCircles()}</g><path d="${dashPaths()}" fill="black"/>
    </mask>
    <mask id="bubbleMask" maskUnits="userSpaceOnUse" ${big}>
      <rect ${big} fill="black"/><path d="${bubblePath()}" fill="white"/><g fill="black">${bubbleDots()}</g>
    </mask>`;
  const body = `
    <rect ${big} fill="${mono ? "#FFFFFF" : COLOR.road}" mask="url(#roadMask)"/>
    <rect ${big} fill="${mono ? "#FFFFFF" : COLOR.bubble}" mask="url(#bubbleMask)"/>`;
  return { defs, body };
}

/** 只有气泡(白色,三个点镂空),放大到填满画布:给很小的单色图标用 */
function bubbleOnly() {
  const { x, y, w, tipY } = BUBBLE;
  const k = (S * 0.84) / Math.max(w, tipY - y);
  const cx = x + w / 2, cy = (y + tipY) / 2;
  const big = `x="-2000" y="-2000" width="6000" height="6000"`;
  return `<g transform="translate(${S / 2} ${S / 2}) scale(${f(k)}) translate(${f(-cx)} ${f(-cy)})"><rect ${big} fill="#FFFFFF" mask="url(#bubbleMask)"/></g>`;
}

/** 圆角方块版(启动图、网页图标):整张图标裁成圆角方块 */
function tile() {
  const m = mark(false);
  const r = S * 0.225;
  return {
    defs: `${bgDefs}${m.defs}<clipPath id="tile"><rect width="${S}" height="${S}" rx="${r}" ry="${r}"/></clipPath>`,
    body: `<g clip-path="url(#tile)">${background}${m.body}</g>`,
  };
}

interface Asset { file: string; size: number; svg: string; transparent: boolean }

function assets(): Asset[] {
  const full = mark(false);
  const mono = mark(true);
  const t = tile();
  return [
    // iOS 和 App Store 用:不透明、没有 alpha 通道(苹果不接受透明图标),圆角由系统加
    { file: "icon.png", size: 1024, transparent: false, svg: svg(1024, `${background}${full.body}`, `${bgDefs}${full.defs}`) },
    // 安卓自适应图标的三层:系统最大只用到 432×432(108dp × 4),512 足够,文件也小
    { file: "android-icon-background.png", size: 512, transparent: false, svg: svg(512, background, bgDefs) },
    { file: "android-icon-foreground.png", size: 512, transparent: true, svg: svg(512, scaled(ADAPTIVE_SCALE, full.body), full.defs) },
    // 安卓 13 以上的"主题图标":系统只取形状,按壁纸颜色着色
    { file: "android-icon-monochrome.png", size: 512, transparent: true, svg: svg(512, scaled(ADAPTIVE_SCALE, mono.body), mono.defs) },
    // 启动图:圆角方块放在中间、四周留白。安卓 12 以上会把启动图标裁成圆形(直径约为画布的 2/3),方块的角不能出圆
    { file: "splash-icon.png", size: 1024, transparent: true, svg: svg(1024, scaled(0.5, t.body), t.defs) },
    { file: "favicon.png", size: 48, transparent: true, svg: svg(48, t.body, t.defs) },
    // 安卓通知栏小图标:只能是白色 + 透明(系统着色),显示只有 24dp,所以只留气泡。
    // 要在 expo-notifications 插件里配置才会用上
    { file: "notification-icon.png", size: 96, transparent: true, svg: svg(96, bubbleOnly(), mono.defs) },
  ];
}

// ---------- 渲染 ----------

async function shoot(page: Page, html: string, width: number, height: number, transparent: boolean): Promise<Buffer> {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
  return page.screenshot({ type: "png", omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
}

/** PNG 头里的颜色类型:2 = RGB(没有 alpha),6 = RGBA */
const pngColorType = (png: Buffer) => png[25];

/** 效果一览:iOS 圆角、安卓圆形/方圆遮罩、主题图标、通知图标、启动图、网页图标 */
function previewHtml(png: Record<string, Buffer>): string {
  const src = (name: string) => `data:image/png;base64,${png[name]!.toString("base64")}`;
  const ios = [180, 120, 87, 60, 40].map((n) => `<img src="${src("icon.png")}" style="width:${n}px;height:${n}px;border-radius:${n * 0.2237}px">`).join("");
  // 自适应图标:只显示中间 72/108 的区域,再套遮罩
  const adaptive = (mask: string, layer: string, bg: string) => `
    <div style="width:160px;height:160px;border-radius:${mask};overflow:hidden;position:relative;background:${bg}">
      ${bg === "none" ? `<img src="${src("android-icon-background.png")}" style="position:absolute;left:-40px;top:-40px;width:240px;height:240px">` : ""}
      <img src="${src(layer)}" style="position:absolute;left:-40px;top:-40px;width:240px;height:240px">
    </div>`;
  const themed = (bg: string, tint: string) => `
    <div style="width:120px;height:120px;border-radius:50%;overflow:hidden;position:relative;background:${bg}">
      <div style="position:absolute;left:-30px;top:-30px;width:180px;height:180px;background:${tint};-webkit-mask:url(${src("android-icon-monochrome.png")}) center/contain no-repeat"></div>
    </div>`;
  return `
    <div style="font:14px sans-serif;padding:24px;background:#EEF0F6;width:1152px;box-sizing:border-box">
      <div style="display:flex;gap:24px;align-items:flex-end">${ios}</div>
      <div style="display:flex;gap:24px;margin-top:24px;align-items:center">
        ${adaptive("50%", "android-icon-foreground.png", "none")}
        ${adaptive("32%", "android-icon-foreground.png", "none")}
        ${themed("#DDE3FF", "#2B3BD6")}${themed("#1E2235", "#C9D3FF")}
        <div style="background:#202124;padding:12px;border-radius:12px;display:flex;gap:12px;align-items:center">
          <img src="${src("notification-icon.png")}" style="width:24px;height:24px"><img src="${src("notification-icon.png")}" style="width:48px;height:48px">
        </div>
        <img src="${src("favicon.png")}" style="width:48px;height:48px"><img src="${src("favicon.png")}" style="width:16px;height:16px">
      </div>
      <div style="display:flex;gap:24px;margin-top:24px">
        <div style="width:200px;height:400px;background:#FFFFFF;border-radius:24px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #ccd">
          <img src="${src("splash-icon.png")}" style="width:200px;height:200px">
        </div>
        <div style="width:200px;height:400px;background:#FFFFFF;border-radius:24px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #ccd">
          <div style="width:192px;height:192px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;outline:1px dashed #f99">
            <img src="${src("splash-icon.png")}" style="width:288px;height:288px">
          </div>
        </div>
        <img src="${src("icon.png")}" style="width:400px;height:400px;border-radius:89px">
      </div>
    </div>`;
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} 后面要写输出目录`);
  return v;
};

const out = arg("--out") ?? ASSETS;
const storeDir = arg("--store");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const list = assets();
  const png: Record<string, Buffer> = {};
  for (const a of list) {
    png[a.file] = await shoot(page, a.svg, a.size, a.size, a.transparent);
    if (!a.transparent && pngColorType(png[a.file]!) !== 2) throw new Error(`${a.file} 应该是不透明的 RGB 图`);
    writeFileSync(join(out, a.file), png[a.file]!);
    console.log(`✓ ${a.file} ${a.size}×${a.size}${a.transparent ? "(透明背景)" : ""}`);
  }
  if (process.argv.includes("--preview")) {
    const buf = await shoot(page, previewHtml(png), 1152, 860, false);
    writeFileSync(join(out, "preview.png"), buf);
    console.log(`✓ 效果一览:${join(out, "preview.png")}`);
  }
  if (storeDir) {
    mkdirSync(storeDir, { recursive: true });
    const icon = list.find((a) => a.file === "icon.png")!;
    // 国内安卓商店常用 512×512、216×216;App Store 用打包进 App 的 1024 图标
    for (const size of [512, 216]) {
      const sized = icon.svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`);
      writeFileSync(join(storeDir, `store-icon-${size}.png`), await shoot(page, sized, size, size, false));
    }
    for (const a of list) writeFileSync(join(storeDir, a.file.replace(/\.png$/, ".svg")), a.svg);
    console.log(`✓ 商店图标和 SVG 源文件:${storeDir}`);
  }
} finally {
  await browser.close();
}
