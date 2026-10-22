import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { checkReorder, gradeItem, issueZh, type Exercise, type GradeResult, type Item, type LanguagePack, type Verdict } from "@lingo/core";
import { say } from "../speech";
import { color, s } from "../theme";
import { Button } from "./Button";

interface Props {
  ex: Exercise;
  pack: LanguagePack;
  item?: Item;
  /** 答完并看过反馈后调用 */
  onDone: (verdict: Verdict, ms: number) => void;
}

/** 渲染一道题:作答 → 显示对错和中文提示 → 继续。 */
export function ExerciseView({ ex, pack, item, onDone }: Props) {
  const started = useRef(Date.now());
  const [result, setResult] = useState<{ verdict: Verdict; text: string } | null>(null);

  useEffect(() => {
    started.current = Date.now();
    setResult(null);
    if (ex.type === "listen-choose") say(ex.say, pack.locale);
  }, [ex, pack.locale]);

  const finish = (verdict: Verdict, text: string) => setResult({ verdict, text });
  const feedback = result && (
    <View style={[s.card, { borderColor: result.verdict === "wrong" ? color.bad : result.verdict === "almost" ? color.warn : color.good }]}>
      <Text style={[s.h2, { color: result.verdict === "wrong" ? color.bad : result.verdict === "almost" ? color.warn : color.good }]}>
        {result.verdict === "correct" ? "答对了" : result.verdict === "almost" ? "基本正确" : "再记一下"}
      </Text>
      {!!result.text && <Text style={s.body}>{result.text}</Text>}
      <Button title="继续" onPress={() => onDone(result.verdict, Date.now() - started.current)} />
    </View>
  );

  switch (ex.type) {
    case "choose-meaning":
    case "listen-choose": {
      const correct = ex.options[ex.answer]!;
      return (
        <View style={{ gap: 12 }}>
          <Text style={s.sub}>{ex.type === "listen-choose" ? "听一听,选出意思" : "选出意思"}</Text>
          {ex.type === "choose-meaning" ? (
            <Pressable onPress={() => say(ex.prompt, pack.locale)}><Text style={s.target}>{ex.prompt} 🔊</Text></Pressable>
          ) : (
            <Button ghost title="🔊 再听一遍" onPress={() => say(ex.say, pack.locale)} />
          )}
          {ex.options.map((o, i) => (
            <Pressable
              key={o}
              disabled={!!result}
              onPress={() => finish(i === ex.answer ? "correct" : "wrong", i === ex.answer ? "" : `正确答案:${correct}`)}
              style={[s.ghost, result && i === ex.answer ? { borderColor: color.good } : null]}
            >
              <Text style={s.ghostText}>{o}</Text>
            </Pressable>
          ))}
          {feedback}
        </View>
      );
    }
    case "choose-article":
      return (
        <View style={{ gap: 12 }}>
          <Text style={s.sub}>选择正确的冠词</Text>
          <Text style={s.target}>___ {ex.noun}</Text>
          <Text style={s.sub}>{ex.zh}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {ex.options.map((o, i) => (
              <View key={o} style={{ flex: 1 }}>
                <Button ghost disabled={!!result} title={o} onPress={() => {
                  const right = `${ex.options[ex.answer]} ${ex.noun}`;
                  say(right, pack.locale);
                  finish(i === ex.answer ? "correct" : "wrong", i === ex.answer ? right : `是 ${right}。名词要连冠词一起记。`);
                }} />
              </View>
            ))}
          </View>
          {feedback}
        </View>
      );
    case "type-target":
      return <TypeAnswer ex={ex} pack={pack} item={item} result={result} onGrade={(g) => finish(g.verdict, describe(g))} feedback={feedback} />;
    case "reorder":
      return <Reorder ex={ex} pack={pack} result={result} onCheck={(ok) => finish(ok ? "correct" : "wrong", ok ? ex.zh : `正确顺序:${ex.answer.join(" ")}`)} feedback={feedback} />;
    case "speak":
      return (
        <View style={{ gap: 12 }}>
          <Text style={s.sub}>听一遍,然后大声跟读</Text>
          <Pressable onPress={() => say(ex.text, pack.locale)}><Text style={s.target}>{ex.text} 🔊</Text></Pressable>
          <Text style={s.sub}>{ex.zh}</Text>
          <Button ghost title="🐢 慢速再听" onPress={() => say(ex.text, pack.locale, true)} />
          {/* 发音评测(录音 → 服务器打分)接入后替换成录音按钮 */}
          {!result && <Button title="我读完了" onPress={() => finish("correct", "")} />}
          {feedback}
        </View>
      );
  }
}

function describe(g: GradeResult): string {
  const tips = g.issues.map(issueZh).join(";");
  if (g.verdict === "correct") return g.expected;
  if (g.verdict === "almost") return `${g.expected}${tips ? `(${tips})` : ""}`;
  return `正确答案:${g.expected}${tips ? `。${tips}` : ""}`;
}

function TypeAnswer({ ex, pack, item, result, onGrade, feedback }: {
  ex: Extract<Exercise, { type: "type-target" }>; pack: LanguagePack; item?: Item;
  result: unknown; onGrade: (g: GradeResult) => void; feedback: React.ReactNode;
}) {
  const [text, setText] = useState("");
  useEffect(() => setText(""), [ex]);
  const submit = () => {
    if (!item) return;
    const g = gradeItem(text, item, pack);
    say(item.text, pack.locale);
    onGrade(g);
  };
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.sub}>用{pack.nameZh}写出来</Text>
      <Text style={s.target}>{ex.promptZh}</Text>
      {!!ex.hint && <Text style={s.sub}>提示:{ex.hint}</Text>}
      <TextInput
        style={s.input}
        value={text}
        onChangeText={setText}
        editable={!result}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={submit}
        placeholder="在这里输入"
      />
      {!result && <Button title="检查" disabled={!text.trim()} onPress={submit} />}
      {feedback}
    </View>
  );
}

function Reorder({ ex, pack, result, onCheck, feedback }: {
  ex: Extract<Exercise, { type: "reorder" }>; pack: LanguagePack;
  result: unknown; onCheck: (ok: boolean) => void; feedback: React.ReactNode;
}) {
  // 记位置而不是词本身:同一个词可能在句子里出现两次
  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => setPicked([]), [ex]);
  const words = picked.map((i) => ex.tiles[i]!);
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.sub}>把词排成句子</Text>
      <Text style={s.h2}>{ex.zh}</Text>
      <View style={[s.card, { minHeight: 60, flexDirection: "row", flexWrap: "wrap", gap: 6 }]}>
        {picked.map((ti, k) => (
          <Pressable key={k} disabled={!!result} onPress={() => setPicked(picked.filter((_, j) => j !== k))} style={tile}>
            <Text style={s.body}>{ex.tiles[ti]}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {ex.tiles.map((w, i) => (
          <Pressable key={i} disabled={!!result || picked.includes(i)} onPress={() => setPicked([...picked, i])}
            style={[tile, { opacity: picked.includes(i) ? 0.25 : 1 }]}>
            <Text style={s.body}>{w}</Text>
          </Pressable>
        ))}
      </View>
      {!result && (
        <Button title="检查" disabled={picked.length !== ex.tiles.length} onPress={() => {
          say(ex.lineText, pack.locale);
          onCheck(checkReorder(ex.answer, words));
        }} />
      )}
      {feedback}
    </View>
  );
}

const tile = { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: color.line, backgroundColor: color.card } as const;
