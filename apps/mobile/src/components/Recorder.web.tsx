import { Text, View } from "react-native";
import { track } from "../analytics";
import { s } from "../theme";
import { SelfCheck, type RecorderProps } from "./SpeakFeedback";

/**
 * 网页预览版的跟读:网页上不录音(给团队看界面、跑自动化测试用,浏览器的麦克风权限和格式都不可靠),
 * 学习者大声跟读后自己判断"像 / 不太像"。接口和手机版 Recorder.tsx 一样。
 */
export function Recorder({ done, onResult }: RecorderProps) {
  if (done) return null;
  return (
    <View style={[s.card, { gap: 10 }]}>
      <Text style={s.sub}>网页版不能录音。大声跟读几遍,再和标准发音比一比。</Text>
      <SelfCheck onPick={(like) => {
        track("speech_attempt", { scored: false, score: null });
        onResult({ verdict: like ? "correct" : "wrong", scored: false, score: null });
      }} />
    </View>
  );
}
