import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { LanguagePack, Line } from "@lingo/core";
import { speakerLabel, speakerOf } from "../content";
import { say, stopSpeaking } from "../speech";
import { s } from "../theme";
import { Button } from "./Button";
import { ChatBubble } from "./ChatBubble";
import { readingOf, ReadingToggle, useReading } from "./Reading";

/**
 * 课文对话 / 例句:每句一个气泡,显示说话人的名字(语言包 cast),按说话人的性别选朗读声音。
 * 逐句听:点一句读一句,长按看中文;也可以从头连着听一遍。日语、韩语有读音的,读音显示在原文下面(可以关)。
 */
export function Dialogue({ lines, pack }: { lines: Line[]; pack: LanguagePack }) {
  const [zh, setZh] = useState<Record<number, boolean>>({});
  const [allZh, setAllZh] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const reading = useReading(lines);
  useEffect(() => () => stopSpeaking(), []);

  // 第一个说话人在左边,第二个在右边,再往后左右交替
  const order = [...new Set(lines.map((l) => l.speaker))];
  const side = (id: string) => (order.indexOf(id) % 2 === 0 ? "left" : "right");

  const read = (i: number, chain = false) => {
    const l = lines[i];
    if (!l) {
      setActive(null);
      return setPlayingAll(false);
    }
    setActive(i);
    say(l.text, pack.locale, false, { gender: speakerOf(pack, l.speaker).gender, voiceKey: l.speaker, ...(chain ? { onDone: () => read(i + 1, true) } : {}) });
  };

  return (
    <View style={{ gap: 10 }}>
      <Text style={s.sub}>点句子听发音,长按看中文</Text>
      {lines.map((l, i) => (
        <ChatBubble
          key={i}
          side={side(l.speaker)}
          name={speakerLabel(speakerOf(pack, l.speaker))}
          text={l.text}
          reading={reading.show ? readingOf(l) : undefined}
          zh={allZh || zh[i] ? l.zh : undefined}
          highlight={active === i}
          onPress={() => { setPlayingAll(false); read(i); }}
          onLongPress={() => setZh({ ...zh, [i]: !zh[i] })}
        />
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flexGrow: 1, flexBasis: 130 }}>
          <Button ghost title={playingAll ? "⏹ 停止" : "▶ 从头听一遍"} onPress={() => {
            if (playingAll) {
              stopSpeaking();
              setActive(null);
              return setPlayingAll(false);
            }
            setPlayingAll(true);
            read(0, true);
          }} />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 130 }}>
          <Button ghost title={allZh ? "隐藏中文" : "显示中文"} onPress={() => setAllZh(!allZh)} />
        </View>
        {reading.has && (
          <View style={{ flexGrow: 1, flexBasis: 130 }}>
            <ReadingToggle reading={reading} />
          </View>
        )}
      </View>
    </View>
  );
}
