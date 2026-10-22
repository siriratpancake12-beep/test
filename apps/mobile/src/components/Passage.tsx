import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { LanguagePack, Line } from "@lingo/core";
import { speakerOf } from "../content";
import { say, stopSpeaking } from "../speech";
import { color, s } from "../theme";
import { Button } from "./Button";

/**
 * 阅读课的短文:句子连成一段(不是对话气泡),像读一篇真的文章。
 * 点一句就朗读这一句,并在下面显示这句的中文;也可以从头连着听,或者打开全文翻译。
 */
export function Passage({ lines, pack }: { lines: Line[]; pack: LanguagePack }) {
  const [active, setActive] = useState<number | null>(null);
  const [allZh, setAllZh] = useState(false);
  const [playingAll, setPlayingAll] = useState(false);
  useEffect(() => () => stopSpeaking(), []);

  const read = (i: number, chain = false) => {
    const l = lines[i];
    if (!l) return setPlayingAll(false);
    setActive(i);
    const sp = speakerOf(pack, l.speaker);
    say(l.text, pack.locale, false, { gender: sp.gender, voiceKey: l.speaker, ...(chain ? { onDone: () => read(i + 1, true) } : {}) });
  };

  return (
    <View style={s.card}>
      <Text style={s.sub}>点句子听发音、看这句的中文</Text>
      <Text style={{ fontSize: 19, lineHeight: 31, color: color.text }}>
        {lines.map((l, i) => (
          <Text key={i} onPress={() => { setPlayingAll(false); read(i); }} style={active === i ? { backgroundColor: "#E6ECFF", color: color.primary } : null}>
            {l.text}
            {i < lines.length - 1 ? " " : ""}
          </Text>
        ))}
      </Text>
      {active !== null && !allZh && <Text style={[s.body, { color: color.sub }]}>💬 {lines[active]?.zh}</Text>}
      {allZh && <Text style={[s.body, { color: color.sub }]}>{lines.map((l) => l.zh).join("")}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flexGrow: 1, flexBasis: 130 }}>
          <Button ghost title={playingAll ? "⏹ 停止" : "▶ 从头听"} onPress={() => {
            if (playingAll) {
              stopSpeaking();
              return setPlayingAll(false);
            }
            setPlayingAll(true);
            read(0, true);
          }} />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 130 }}>
          <Button ghost title={allZh ? "收起翻译" : "全文翻译"} onPress={() => setAllZh(!allZh)} />
        </View>
      </View>
    </View>
  );
}
