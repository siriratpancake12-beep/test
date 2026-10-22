import { Pressable, Text, View } from "react-native";
import type { SpeechScoreRes, Verdict } from "@lingo/core";
import type { Gender } from "../speech";
import { say } from "../speech";
import { color, s } from "../theme";

/** 一次跟读的结果:有服务器打分时 scored = true、score 是 0–100;自己判断时 score = null */
export interface SpeakResult { verdict: Verdict; scored: boolean; score: number | null }

/** 录音组件(Recorder.tsx 手机版、Recorder.web.tsx 网页版)共用的参数 */
export interface RecorderProps {
  /** 要跟读的句子 */
  text: string;
  /** 朗读标准发音用的区域代码(de-DE) */
  locale: string;
  /** 语种代码(打分接口要) */
  lang: string;
  /** 标准发音用哪种声音(课文说话人的性别) */
  gender?: Gender;
  voiceKey?: string;
  /** 已经出结果了:收起录音和自评按钮,只留回放 */
  done?: boolean;
  /** 有分数时确认结果的按钮文字(练习题里是"完成",逐句跟读里是"下一句") */
  nextLabel?: string;
  onResult: (r: SpeakResult) => void;
}

/** 服务器打分 → 对错:80 分以上算读得好,60–79 基本对,60 以下要再练 */
export const verdictOfScore = (score: number): Verdict => (score >= 80 ? "correct" : score >= 60 ? "almost" : "wrong");

export const scoreColor = (score: number) => (score >= 80 ? color.good : score >= 60 ? color.warn : color.bad);

/** 评测服务的错误类型 → 中文 */
const WORD_ERROR: Record<string, string> = {
  Mispronunciation: "发音不准",
  Omission: "漏读",
  Insertion: "多读",
  UnexpectedBreak: "停顿不当",
  MissingBreak: "缺少停顿",
  Monotone: "语调太平",
};

/** 自己判断像不像(没有打分服务时)。testID 和选择题一样,自动化测试可以点。 */
export function SelfCheck({ onPick, prompt = "和标准发音比一比,像吗?" }: { onPick: (like: boolean) => void; prompt?: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.sub}>{prompt}</Text>
      <View style={row}>
        <Pressable testID="option" accessibilityRole="button" onPress={() => onPick(true)} style={[s.ghost, grow, { borderColor: color.good }]}>
          <Text style={s.ghostText}>👍 像</Text>
        </Pressable>
        <Pressable testID="option" accessibilityRole="button" onPress={() => onPick(false)} style={[s.ghost, grow]}>
          <Text style={s.ghostText}>🤔 不太像</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 服务器打分结果:总分、三项分数、逐词颜色(点词听这个词)。 */
export function ScoreView({ res, locale }: { res: SpeechScoreRes; locale: string }) {
  const weak = res.words.filter((w) => w.score < 60 || (w.error && w.error !== "None"));
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.h1, { color: scoreColor(res.score) }]}>{Math.round(res.score)} 分</Text>
      <Text style={s.sub}>准确 {Math.round(res.accuracy)} · 流利 {Math.round(res.fluency)} · 完整 {Math.round(res.completeness)}</Text>
      <View style={[row, { gap: 6 }]}>
        {res.words.map((w, i) => {
          const omitted = w.error === "Omission";
          return (
            <Pressable key={`${w.word}-${i}`} onPress={() => say(w.word, locale)} style={[chip, { borderColor: omitted ? color.line : scoreColor(w.score) }]}>
              <Text style={[s.body, { color: omitted ? color.sub : scoreColor(w.score), textDecorationLine: omitted ? "line-through" : "none" }]}>{w.word}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={s.sub}>
        绿色读得好、橙色还可以、红色要多练,点词可以听这个词。
        {weak.length ? ` 要注意:${weak.slice(0, 3).map((w) => `${w.word}(${WORD_ERROR[w.error] ?? "发音不准"})`).join("、")}` : ""}
      </Text>
    </View>
  );
}

const row = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
const grow = { flexGrow: 1, flexBasis: 120, paddingHorizontal: 12 } as const;
const chip = { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, backgroundColor: color.card } as const;
