import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { recordAnswer, recordCheckpoint, todayOf, todaysReview, type Exercise, type Item, type Verdict } from "@lingo/core";
import {
  CHECKPOINT_PASS, checkpointLessonId, checkpointQuestions, goalReached, scoreCheckpoint, unitCheckpoint, unitLabel, unitOfLesson,
  unitPracticeQuestions, type CheckpointScore,
} from "@lingo/core/src/checkpoint";
import { track } from "../analytics";
import { toAnswer } from "../answers";
import { Button } from "../components/Button";
import { ExerciseView, type ExerciseResult } from "../components/ExerciseView";
import { markUnitPractice, unitMinutes } from "../components/UnitCards";
import { getLessons, getPack, itemPool } from "../content";
import { say } from "../speech";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * 单元测评(默认)和单元练习(mode=practice),参数 lesson 是这个单元里任意一课的 id。
 * - 练习:约 25 题,不计分,做完提示去测评;
 * - 测评:12–15 题,80 分通过 → 证书页;没通过 → 列出要复习的词和句子,可以再测(换一套题)。
 * 两种的作答都照常记进复习卡:答错的词很快会在复习里再出现。测评和练习都不收费(考的是已经学过的内容)。
 */
type Phase = "intro" | "test" | "result";

export default function CheckpointRoute() {
  const { lesson, mode } = useLocalSearchParams<{ lesson?: string; mode?: string }>();
  // 从练习直接换到测评(同一个页面换参数)时,做题的状态要从头开始
  return <Checkpoint key={`${lesson}:${mode ?? "test"}`} lesson={lesson} practiceMode={mode === "practice"} />;
}

function Checkpoint({ lesson, practiceMode }: { lesson?: string; practiceMode: boolean }) {
  const { lang, progress, update } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  const lessons = lang ? getLessons(lang) : [];
  const unit = useMemo(() => unitOfLesson(lessons, lesson), [lessons, lesson]);
  const pool = useMemo(() => (lang ? itemPool(lang) : []), [lang]);
  const items = useMemo(() => new Map(pool.map((i) => [i.id, i])), [pool]);
  const [seed, setSeed] = useState(() => Date.now() % 100000);
  const questions = useMemo<Exercise[]>(
    () => (unit && pack ? (practiceMode ? unitPracticeQuestions : checkpointQuestions)(unit.lessons, pool, pack, seed) : []),
    [unit, pack, pool, seed, practiceMode],
  );
  const [phase, setPhase] = useState<Phase>("intro");
  const [qi, setQi] = useState(0);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [result, setResult] = useState<(CheckpointScore & { reached: boolean }) | null>(null);

  if (!pack || !progress) return null;
  if (!unit) return <View style={[s.screen, s.pad]}><Text style={s.body}>找不到这个单元</Text></View>;
  const { code, theme } = unitLabel(unit.unit);
  const title = `${code} ${practiceMode ? "单元练习" : "单元测评"}`;
  const st = unitCheckpoint(progress, unit.lessons);
  const lessonId = checkpointLessonId(unit.lessons);

  if (!st.ready) {
    const left = unit.lessons.filter((l) => !(l.id in progress.completed) && !progress.skipped.includes(l.id)).length;
    return (
      <View style={[s.screen, s.pad]}>
        <Stack.Screen options={{ title }} />
        <View style={s.card}>
          <Text style={s.h2}>学完这个单元的课再来</Text>
          <Text style={s.body}>这个单元还有 {left} 节课没学。单元练习和测评考的是整个单元的内容。</Text>
          <Button title="回首页" onPress={() => router.dismissTo("/")} />
        </View>
      </View>
    );
  }

  const restart = () => {
    setSeed((x) => x + 1);
    setQi(0);
    setVerdicts([]);
    setResult(null);
    setPhase("test");
  };

  const answer = (ex: Exercise, r: ExerciseResult) => {
    const now = new Date();
    update((p) => recordAnswer(p, toAnswer(ex, r), now));
    const vs = [...verdicts, r.verdict];
    setVerdicts(vs);
    if (qi + 1 < questions.length) return setQi(qi + 1);
    const sc = scoreCheckpoint(questions, vs);
    if (practiceMode) {
      void markUnitPractice(progress.lang, unit, todayOf(progress, now));
      setResult({ ...sc, reached: false });
    } else {
      update((p) => recordCheckpoint(p, lessonId, sc.score, now));
      track("checkpoint_complete", { unit: unit.unit, score: sc.score, total: sc.total });
      // 通过最后一个单元的测评也可能让目标达成:当场告诉他,并引导定下一个目标
      setResult({ ...sc, reached: sc.passed && goalReached(recordCheckpoint(progress, lessonId, sc.score, now), lessons) });
    }
    setPhase("result");
  };

  const covered = [
    "看懂", "听懂", "写出来",
    ...(questions.some((q) => q.type === "choose-article") ? ["选冠词"] : []),
    ...(questions.some((q) => q.type === "reorder") ? ["句子排序"] : []),
  ].join("、");
  const ex = questions[qi];

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title }} />

      {phase === "intro" && (
        <View style={s.card}>
          <Text style={s.sub}>{practiceMode ? "📚 单元练习" : "📝 单元测评"}</Text>
          <Text style={s.h1}>{code}{theme ? ` ${theme}` : ""}</Text>
          {practiceMode ? (
            <Text style={s.body}>从这个单元学过的全部词和句子里出 {questions.length} 道题,{covered}都有。不计分,练完再去测评更有把握。</Text>
          ) : (
            <Text style={s.body}>共 {questions.length} 题:{covered}。{CHECKPOINT_PASS} 分通过,通过后发单元证书。</Text>
          )}
          <Text style={s.sub}>
            约 {unitMinutes(questions.length)} 分钟 · 答错的词会排进复习
            {!practiceMode && st.best ? ` · 之前最好 ${st.best.score} 分` : ""}
          </Text>
          <Button title={practiceMode ? "开始单元练习" : "开始测评"} onPress={() => setPhase("test")} />
        </View>
      )}

      {phase === "test" && ex && (
        <>
          <Text style={s.sub}>{practiceMode ? "单元练习" : "单元测评"} {qi + 1}/{questions.length}</Text>
          <ExerciseView ex={ex} pack={pack} item={"itemId" in ex ? items.get(ex.itemId) : undefined} onDone={(r) => answer(ex, r)} />
        </>
      )}

      {phase === "result" && result && (practiceMode ? (
        <View style={s.card}>
          <Text style={s.h1}>练习完成</Text>
          <Text style={s.body}>答对 {result.right}/{result.total}。{result.missedItems.length ? "答错的词已经排进复习。" : "全都会了!"}</Text>
          <Missed result={result} items={items} locale={pack.locale} />
          <Button title="去做单元测评" onPress={() => router.replace(`/checkpoint?lesson=${lessonId}`)} />
          <Button ghost title="回首页" onPress={() => router.dismissTo("/")} />
        </View>
      ) : result.passed ? (
        <View style={[s.card, { borderColor: color.good }]}>
          <Text style={s.h1}>🎉 通过了!</Text>
          <Text style={[s.h1, { color: color.good }]}>{result.score} 分</Text>
          <Text style={s.sub}>答对 {result.right}/{result.total} · {CHECKPOINT_PASS} 分通过</Text>
          <Button title="🏅 查看单元证书" onPress={() => router.replace(`/certificate?lesson=${lessonId}`)} />
          {result.reached && (
            <View style={[s.card, { borderColor: color.primary }]}>
              <Text style={s.h2}>🏁 你达到了自己定的目标 {progress.goal?.target}!</Text>
              <Button ghost title="设定下一个目标" onPress={() => router.replace("/plan")} />
            </View>
          )}
          <Button ghost title="回首页" onPress={() => router.dismissTo("/")} />
        </View>
      ) : (
        <View style={[s.card, { borderColor: color.warn }]}>
          <Text style={s.h1}>{result.score} 分</Text>
          <Text style={s.body}>
            {result.score >= 60 ? "还差一点" : "这个单元还不太熟"}:{CHECKPOINT_PASS} 分通过。把下面这些复习一下,再来测。
          </Text>
          <Missed result={result} items={items} locale={pack.locale} />
          <Text style={s.sub}>答错的词已经排进复习,过一会儿就会出现。</Text>
          {todaysReview(progress, new Date()).length > 0 && <Button ghost title="现在去复习" onPress={() => router.replace("/review")} />}
          <Button title="再测一次(换一套题)" onPress={restart} />
          <Button ghost title="回首页" onPress={() => router.dismissTo("/")} />
        </View>
      ))}
    </ScrollView>
  );
}

/** 答错的词(点了听发音)和排错的句子 */
function Missed({ result, items, locale }: { result: CheckpointScore; items: Map<string, Item>; locale: string }) {
  const words = result.missedItems.map((id) => items.get(id)).filter((x): x is Item => !!x);
  if (!words.length && !result.missedLines.length) return null;
  return (
    <View style={{ gap: 6 }}>
      {words.length > 0 && <Text style={s.h2}>这些词再记一下</Text>}
      {words.map((w) => (
        <Pressable key={w.text} onPress={() => say(w.text, locale)} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
          <Text style={[s.body, { fontWeight: "600" }]}>{w.text} 🔊</Text>
          <Text style={s.sub}>{w.zh}</Text>
        </Pressable>
      ))}
      {result.missedLines.length > 0 && <Text style={s.h2}>这些句子再读一读</Text>}
      {result.missedLines.map((t) => (
        <Pressable key={t} onPress={() => say(t, locale)}>
          <Text style={s.body}>{t} 🔊</Text>
        </Pressable>
      ))}
    </View>
  );
}
