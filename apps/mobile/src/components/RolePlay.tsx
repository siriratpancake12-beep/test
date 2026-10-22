import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { LanguagePack, Line, Verdict } from "@lingo/core";
import { speakerLabel, speakerOf } from "../content";
import { say, stopSpeaking } from "../speech";
import { color, s } from "../theme";
import { Button } from "./Button";
import { ChatBubble } from "./ChatBubble";

/** 上面留几句已经说过的,当作上下文(不用嵌套滚动,当前这句总在屏幕上) */
const CONTEXT = 2;

/**
 * 角色扮演:学习者选一个角色,App 用合成语音说对方的句子,学习者说自己的句子。
 * 第一遍看着原文说;第二遍只给中文提示,自己想出来再看原文对一对——从"跟着读"走到"自己说"。
 * 只有第二遍的自评交给 onAnswer(记进进度的"说"):第一遍看着读,算"对"会把口语成绩虚高。
 * 两遍都完成(或跳过)调用 onFinish。
 */
export function RolePlay({ lines, pack, onAnswer, onFinish }: {
  lines: Line[];
  pack: LanguagePack;
  onAnswer: (verdict: Verdict) => void;
  onFinish: () => void;
}) {
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const [role, setRole] = useState<string | null>(null);
  const [round, setRound] = useState<1 | 2>(1);
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const line = lines[i];
  const voiceOf = (l: Line) => ({ gender: speakerOf(pack, l.speaker).gender, voiceKey: l.speaker });
  const hear = (l: Line) => say(l.text, pack.locale, false, voiceOf(l));
  const nameOf = (l: Line) => speakerLabel(speakerOf(pack, l.speaker));

  // 轮到对方:自动说出来
  useEffect(() => {
    if (role && line && line.speaker !== role) hear(line);
  }, [role, round, i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopSpeaking(), []);

  const next = () => {
    setRevealed(false);
    setI(i + 1);
  };
  const endOfRound = () => {
    if (round === 2) return onFinish();
    setRound(2);
    setI(0);
  };
  const skip = <Text style={[s.sub, { color: color.primary, textAlign: "center" }]} onPress={onFinish}>跳过角色扮演</Text>;

  if (!role) {
    return (
      <View style={{ gap: 12 }}>
        <Text style={s.h2}>角色扮演</Text>
        <Text style={s.body}>选一个角色:你说 TA 的台词,对方的话由 App 来说。第一遍看着原文说,第二遍只看中文提示。</Text>
        {speakers.map((id) => (
          <Pressable key={id} testID="option" accessibilityRole="button" onPress={() => setRole(id)} style={s.card}>
            <Text style={s.h2}>我来演 {speakerLabel(speakerOf(pack, id))}</Text>
            <Text style={s.sub}>{lines.filter((l) => l.speaker === id).length} 句台词</Text>
          </Pressable>
        ))}
        {skip}
      </View>
    );
  }

  const context = lines.slice(Math.max(0, i - CONTEXT), i);
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.sub}>角色扮演 · 第 {round} 遍{round === 1 ? "(看着原文说)" : "(只看中文提示)"} · {Math.min(i + 1, lines.length)}/{lines.length}</Text>
      {context.map((l, k) => (
        <ChatBubble key={`${round}-${i - context.length + k}`} side={l.speaker === role ? "right" : "left"} name={nameOf(l)} text={l.text} onPress={() => hear(l)} />
      ))}

      {!line ? (
        <View style={[s.card, { borderColor: color.good }]}>
          <Text style={s.body}>{round === 1 ? "第一遍完成!第二遍不看原文,只看中文提示,自己说出来。" : "两遍都完成了:这段对话你已经能自己说出来了。"}</Text>
          <Button title="继续" onPress={endOfRound} />
        </View>
      ) : line.speaker !== role ? (
        <ChatBubble side="left" name={nameOf(line)} text={line.text} zh={line.zh} highlight onPress={() => hear(line)}>
          <Button title="继续" onPress={next} />
        </ChatBubble>
      ) : round === 1 ? (
        <ChatBubble side="right" name="轮到你说" text={line.text} zh={line.zh} highlight onPress={() => hear(line)}>
          <Text style={s.sub}>大声说出来(点句子可以先听一遍)</Text>
          <Button title="我读完了" onPress={next} />
        </ChatBubble>
      ) : !revealed ? (
        <ChatBubble side="right" name="轮到你说" highlight>
          <Text style={s.h2}>{line.zh}</Text>
          <Text style={s.sub}>用{pack.nameZh}说出来,说完再看原文</Text>
          <Pressable testID="option" accessibilityRole="button" onPress={() => setRevealed(true)} style={s.ghost}>
            <Text style={s.ghostText}>说完了,看原文</Text>
          </Pressable>
        </ChatBubble>
      ) : (
        <ChatBubble side="right" name="原文" text={line.text} zh={line.zh} highlight onPress={() => hear(line)}>
          <Text style={s.sub}>点句子听标准发音。你说对了吗?</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {([["✅ 说对了", "correct"], ["🤔 没说对", "wrong"]] as const).map(([title, v]) => (
              <Pressable key={v} testID="option" accessibilityRole="button" onPress={() => { onAnswer(v); next(); }}
                style={[s.ghost, { flexGrow: 1, flexBasis: 100, paddingHorizontal: 12 }]}>
                <Text style={s.ghostText}>{title}</Text>
              </Pressable>
            ))}
          </View>
        </ChatBubble>
      )}
      {!!line && skip}
    </View>
  );
}
