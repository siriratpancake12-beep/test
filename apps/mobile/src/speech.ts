import * as Speech from "expo-speech";

/**
 * 朗读。开发阶段用系统自带的语音合成(免费、离线);
 * 正式版换成预先生成的真人/商用授权音频(课程里的 audio 字段),系统合成只做兜底。
 *
 * 课文按说话人的性别选声音(语言包 cast 里写了性别):男女角色听起来不一样,对话更容易听懂。
 * 系统接口不告诉声音是男是女,只能按声音的名字猜;猜不出来、或者手机上没有对应的声音,就用默认声音。
 */
export type Gender = "f" | "m";

export interface SayOptions {
  /** 说话人的性别:按它选声音 */
  gender?: Gender;
  /** 同性别的不同角色尽量用不同的声音(按角色 id 固定分配,同一个人每次都是同一个声音) */
  voiceKey?: string;
  /** 读完时调用(用来连着读几句、先放标准音再放录音);被打断时不调用 */
  onDone?: () => void;
}

export function say(text: string, locale: string, slow = false, opts: SayOptions = {}) {
  Speech.stop();
  loadVoices();
  const voice = opts.gender ? pickVoice(locale, opts.gender, opts.voiceKey ?? "") : undefined;
  Speech.speak(text, {
    language: locale,
    rate: slow ? 0.6 : 0.95,
    ...(voice ? { voice } : {}),
    ...(opts.onDone ? { onDone: opts.onDone } : {}),
  });
}

/** 停止朗读(开始录音前、离开页面时) */
export function stopSpeaking() {
  Speech.stop().catch(() => {});
}

// 声音列表异步取一次。取到之前先用默认声音读,不让第一句等着(网页上取列表可能一直没有回音)。
// 安卓的语音引擎没准备好时会返回空列表,下次再取。
let voices: Speech.Voice[] = [];
let voicesState: "idle" | "loading" | "done" = "idle";
function loadVoices() {
  if (voicesState !== "idle") return;
  voicesState = "loading";
  Speech.getAvailableVoicesAsync()
    .then((v) => {
      voices = v;
      voicesState = v.length ? "done" : "idle";
    })
    .catch(() => {
      voicesState = "idle";
    });
}

// 常见系统声音的名字(iOS、安卓、Windows / Chrome 网页)。只用来分男女声,不全也没关系;
// 不放机器味很重的趣味声音(Eloquence、Fred 等),免得被选中
const FEMALE = new Set([
  "anna", "petra", "helena", "katja", "hedda", "marlene", "vicki", "amala", "elke", "seraphina",
  "samantha", "victoria", "allison", "ava", "susan", "karen", "moira", "tessa", "fiona", "kate", "serena", "martha", "catherine",
  "zoe", "nicky", "joelle", "noelle", "zira", "hazel", "jenny", "aria", "sonia", "libby", "emma", "michelle",
  "amelie", "amélie", "aurelie", "aurélie", "audrey", "marie", "julie", "hortense", "denise", "celine", "céline", "chantal",
  "brigitte", "vivienne", "eloise", "coralie", "yvette", "josephine",
]);
const MALE = new Set([
  "markus", "yannick", "martin", "viktor", "conrad", "stefan", "hans", "killian", "florian", "ralf", "bernd", "christoph", "kasper",
  "alex", "tom", "aaron", "evan", "nathan", "daniel", "arthur", "oliver", "rishi", "gordon", "lee", "david", "mark", "guy", "ryan",
  "christopher", "eric", "roger", "thomas", "jacques", "nicolas", "paul", "henri", "claude", "guillaume", "remy", "rémy", "maurice",
  "alain", "antoine", "fabrice", "jerome", "jérôme", "remi", "rémi",
]);

function genderOf(v: Speech.Voice): Gender | undefined {
  const s = `${v.name} ${v.identifier}`.toLowerCase();
  // 部分安卓声音名里直接写了 female / male(比如 en-us-x-sfg#female_1-local)
  if (s.includes("female")) return "f";
  if (/(^|[^e])male/.test(s)) return "m";
  for (const w of s.split(/[^\p{L}]+/u)) {
    if (FEMALE.has(w)) return "f";
    if (MALE.has(w)) return "m";
  }
  return undefined;
}

const norm = (l: string) => l.toLowerCase().replace(/_/g, "-");

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 选一个合适的声音:同地区(de-DE)优先,其次同语言(de-AT、de-CH);有增强音质的先用增强的。 */
function pickVoice(locale: string, gender: Gender, key: string): string | undefined {
  const loc = norm(locale);
  const lang = loc.split("-")[0];
  const fits = voices.filter((v) => genderOf(v) === gender);
  const exact = fits.filter((v) => norm(v.language) === loc);
  const near = exact.length ? exact : fits.filter((v) => norm(v.language).split("-")[0] === lang);
  if (!near.length) return undefined;
  const enhanced = near.filter((v) => v.quality === Speech.VoiceQuality.Enhanced);
  const pool = enhanced.length ? enhanced : near;
  return pool[hash(key) % pool.length]!.identifier;
}
