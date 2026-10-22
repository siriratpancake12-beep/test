import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { checkReorder, gradeItem, issueZh, type Exercise, type GradeResult, type Issue, type Item, type LanguagePack, type Verdict } from "@lingo/core";
import { say } from "../speech";
import { color, s } from "../theme";
import { Button } from "./Button";
import { Recorder } from "./Recorder";
import type { SpeakResult } from "./SpeakFeedback";

interface Props {
  ex: Exercise;
  pack: LanguagePack;
  item?: Item;
  /** 答完并看过反馈后调用;issues 是错在哪(冠词、重音……),用来找弱点 */
  onDone: (r: ExerciseResult) => void;
}

export interface ExerciseResult { verdict: Verdict; ms: number; issues: Issue[] }

/** 渲染一道题:作答 → 显示对错和中文提示 → 继续。 */
export function ExerciseView({ ex, pack, item, onDone }: Props) {
  const started = useRef(Date.now());
  const [result, setResult] = useState<{ verdict: Verdict; text: string; issues: Issue[]; ms: number } | null>(null);

  useEffect(() => {
    started.current = Date.now();
    setResult(null);
    if (ex.type === "listen-choose") say(ex.say, pack.locale);
    // 跟读题先听一遍再录
    if (ex.type === "speak") say(ex.text, pack.locale);
  }, [ex, pack.locale]);

  const finish = (verdict: Verdict, text: string, issues: Issue[] = []) => {
    Haptics.notificationAsync(verdict === "wrong" ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success).catch(() => {});
    // 计时到作答为止,看反馈的时间不算(否则"答得快"的判断不准)
    setResult({ verdict, text, issues, ms: Date.now() - started.current });
  };
  const titles = ex.type === "speak" ? SPEAK_TITLE : TITLE;
  const feedback = result && (
    <View style={[s.card, { borderColor: result.verdict === "wrong" ? color.bad : result.verdict === "almost" ? color.warn : color.good }]}>
      <Text style={[s.h2, { color: result.verdict === "wrong" ? color.bad : result.verdict === "almost" ? color.warn : color.good }]}>
        {titles[result.verdict]}
      </Text>
      {!!result.text && <Text style={s.body}>{result.text}</Text>}
      <Button title="继续" onPress={() => onDone({ verdict: result.verdict, ms: result.ms, issues: result.issues })} />
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
              testID="option"
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
                <Button ghost testID="option" disabled={!!result} title={o} onPress={() => {
                  const right = `${ex.options[ex.answer]} ${ex.noun}`;
                  say(right, pack.locale);
                  const issues: Issue[] = i === ex.answer ? [] : [{ kind: "article", expected: ex.options[ex.answer]!, got: o }];
                  finish(i === ex.answer ? "correct" : "wrong", i === ex.answer ? right : `是 ${right}。名词要连冠词一起记。`, issues);
                }} />
              </View>
            ))}
          </View>
          {feedback}
        </View>
      );
    case "type-target":
      return <TypeAnswer ex={ex} pack={pack} item={item} result={result} onGrade={(g) => finish(g.verdict, describe(g), g.issues)} feedback={feedback} />;
    case "reorder":
      return <Reorder ex={ex} pack={pack} result={result} onCheck={(ok) => finish(ok ? "correct" : "wrong", ok ? ex.zh : `正确顺序:${ex.answer.join(" ")}`)} feedback={feedback} />;
    case "speak":
      // 跟读:听 → 录 → 回放对比;有服务器打分就按分数算对错,没有就学习者自己判断像不像
      return (
        <View style={{ gap: 12 }}>
          <Text style={s.sub}>听一遍,录下你的跟读,再和标准发音比一比</Text>
          <Pressable onPress={() => say(ex.text, pack.locale)}><Text style={s.target}>{ex.text} 🔊</Text></Pressable>
          <Text style={s.sub}>{ex.zh}</Text>
          <Button ghost title="🐢 慢速再听" onPress={() => say(ex.text, pack.locale, true)} />
          <Recorder text={ex.text} locale={pack.locale} lang={pack.code} done={!!result} onResult={(r) => finish(r.verdict, speakNote(r))} />
          {feedback}
        </View>
      );
  }
}

const TITLE: Record<Verdict, string> = { correct: "答对了", almost: "基本正确", wrong: "再记一下" };
const SPEAK_TITLE: Record<Verdict, string> = { correct: "读得很像!", almost: "差不多了", wrong: "多跟读几遍" };

function speakNote(r: SpeakResult): string {
  if (r.scored && r.score !== null) return `发音 ${r.score} 分。${r.score < 80 ? "红色、橙色的词多听几遍再读。" : "保持每天开口。"}`;
  return r.verdict === "correct" ? "坚持每天开口,越读越像。" : "多听几遍标准发音,注意重音和语调,下次会更像。";
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
        testID="answer-input"
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
          <Pressable key={i} testID="tile" disabled={!!result || picked.includes(i)} onPress={() => setPicked([...picked, i])}
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
