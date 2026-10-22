import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { LanguagePack, Line, Verdict } from "@lingo/core";
import { speakerLabel, speakerOf } from "../content";
import { say, stopSpeaking } from "../speech";
import { color, s } from "../theme";
import { Button } from "./Button";
import { Recorder } from "./Recorder";

/**
 * 逐句跟读:每一句都 听 → 录 → 回放对比(或服务器打分)。"开不了口"是中国学习者的头号痛点,
 * 课文的每一句都自己说一遍,才算真的学过这课。不能录音(没权限、网页预览)时可以自己判断,也可以整段跳过。
 * 每句的结果交给 onAnswer(记进进度的"说"),全部读完调用 onFinish。
 */
export function Shadowing({ lines, pack, onAnswer, onFinish }: {
  lines: Line[];
  pack: LanguagePack;
  onAnswer: (verdict: Verdict) => void;
  onFinish: () => void;
}) {
  const [i, setI] = useState(0);
  const [showZh, setShowZh] = useState(false);
  const line = lines[i];
  const sp = line ? speakerOf(pack, line.speaker) : undefined;
  const voice = line && sp ? { gender: sp.gender, voiceKey: line.speaker } : {};

  // 每到新的一句先放一遍标准发音
  useEffect(() => {
    if (line) say(line.text, pack.locale, false, voice);
    setShowZh(false);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopSpeaking(), []);

  if (!line || !sp) return null;
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.sub}>逐句跟读 {i + 1}/{lines.length} · 听 → 录 → 和标准发音比一比</Text>
      <Pressable onPress={() => say(line.text, pack.locale, false, voice)} onLongPress={() => setShowZh(!showZh)} style={s.card}>
        <Text style={s.sub}>{speakerLabel(sp)}</Text>
        <Text style={s.target}>{line.text} 🔊</Text>
        {showZh ? <Text style={s.sub}>{line.zh}</Text> : <Text style={[s.sub, { color: color.primary }]} onPress={() => setShowZh(true)}>看中文</Text>}
      </Pressable>
      <Button ghost title="🐢 慢速再听" onPress={() => say(line.text, pack.locale, true, voice)} />
      <Recorder
        key={i}
        text={line.text}
        locale={pack.locale}
        lang={pack.code}
        {...voice}
        nextLabel={i + 1 < lines.length ? "下一句" : "完成跟读"}
        onResult={(r) => {
          onAnswer(r.verdict);
          if (i + 1 < lines.length) setI(i + 1);
          else onFinish();
        }}
      />
      <Text style={[s.sub, { color: color.primary, textAlign: "center" }]} onPress={onFinish}>现在不方便开口?跳过跟读</Text>
    </View>
  );
}
