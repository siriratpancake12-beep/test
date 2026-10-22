import * as Speech from "expo-speech";

/**
 * 朗读。开发阶段用系统自带的语音合成(免费、离线);
 * 正式版换成预先生成的真人/商用授权音频(课程里的 audio 字段),系统合成只做兜底。
 */
export function say(text: string, locale: string, slow = false) {
  Speech.stop();
  Speech.speak(text, { language: locale, rate: slow ? 0.6 : 0.95 });
}
