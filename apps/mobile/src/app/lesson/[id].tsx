import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { completeLesson, lessonPractice, recordAnswer, type Exercise } from "@lingo/core";
import { Button } from "../../components/Button";
import { ExerciseView } from "../../components/ExerciseView";
import { getLesson, getPack, itemPool } from "../../content";
import { say } from "../../speech";
import { useStore } from "../../store";
import { color, s } from "../../theme";

/** 一节课:对话 → 生词 → 语法 → 练习 → 完成。 */
type Step = "dialogue" | "words" | "grammar" | "practice" | "done";

export default function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lesson = getLesson(id);
  const pack = lesson && getPack(lesson.lang);
  const { update } = useStore();
  const [step, setStep] = useState<Step>(lesson?.lines.length ? "dialogue" : "words");
  const [showZh, setShowZh] = useState<Record<number, boolean>>({});
  const [qi, setQi] = useState(0);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const practice = useMemo<Exercise[]>(
    () => (lesson && pack ? lessonPractice(lesson, itemPool(lesson.lang), pack, Date.now() % 100000) : []),
    [lesson, pack],
  );

  if (!lesson || !pack) return <Text style={s.body}>找不到这节课</Text>;
  const items = new Map(itemPool(lesson.lang).map((i) => [i.id, i]));

  const afterWords = () => setStep(lesson.grammar.length ? "grammar" : "practice");
  const answer = (ex: Exercise, verdict: "correct" | "almost" | "wrong", ms: number) => {
    const now = new Date();
    if ("itemId" in ex) update((p) => recordAnswer(p, ex.itemId, ex.direction, verdict, now, ms));
    setScore((sc) => ({ right: sc.right + (verdict === "wrong" ? 0 : 1), total: sc.total + 1 }));
    if (qi + 1 < practice.length) setQi(qi + 1);
    else {
      update((p) => completeLesson(p, lesson, now));
      setStep("done");
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Stack.Screen options={{ title: lesson.titleZh }} />
      {step === "dialogue" && (
        <>
          <Text style={s.sub}>点句子听发音,长按看中文</Text>
          {lesson.lines.map((l, i) => (
            <Pressable key={i} onPress={() => say(l.text, pack.locale)} onLongPress={() => setShowZh({ ...showZh, [i]: !showZh[i] })} style={s.card}>
              <Text style={s.sub}>{l.speaker}</Text>
              <Text style={s.target}>{l.text}</Text>
              {showZh[i] && <Text style={s.sub}>{l.zh}</Text>}
            </Pressable>
          ))}
          <Button title="学生词" onPress={() => setStep("words")} />
        </>
      )}

      {step === "words" && (
        <>
          {lesson.newItems.map((it) => (
            <Pressable key={it.id} onPress={() => say(it.text, pack.locale)} style={s.card}>
              <Text style={s.target}>{it.text} 🔊</Text>
              <Text style={s.body}>{it.zh}</Text>
              {[it.features.reading, it.features.roman, it.features.ipa && `/${it.features.ipa}/`, it.features.plural && it.features.plural !== "-" && `复数:${it.features.plural}`]
                .filter(Boolean).map((t) => <Text key={String(t)} style={s.sub}>{t}</Text>)}
              {!!it.noteZh && <Text style={[s.sub, { color: color.primary }]}>💡 {it.noteZh}</Text>}
            </Pressable>
          ))}
          <Button title="下一步" onPress={afterWords} />
        </>
      )}

      {step === "grammar" && (
        <>
          {lesson.grammar.map((g) => (
            <View key={g.id} style={s.card}>
              <Text style={s.h2}>{g.titleZh}</Text>
              <Text style={s.body}>{g.bodyZh}</Text>
              {g.examples.map((e) => (
                <Pressable key={e.text} onPress={() => say(e.text, pack.locale)}>
                  <Text style={s.target}>{e.text} 🔊</Text>
                  <Text style={s.sub}>{e.zh}</Text>
                </Pressable>
              ))}
            </View>
          ))}
          <Button title="开始练习" onPress={() => setStep("practice")} />
        </>
      )}

      {step === "practice" && practice[qi] && (
        <>
          <Text style={s.sub}>练习 {qi + 1}/{practice.length}</Text>
          <ExerciseView
            ex={practice[qi]!}
            pack={pack}
            item={"itemId" in practice[qi]! ? items.get((practice[qi] as { itemId: string }).itemId) : undefined}
            onDone={(v, ms) => answer(practice[qi]!, v, ms)}
          />
        </>
      )}

      {step === "done" && (
        <View style={s.card}>
          <Text style={s.h1}>🎉 学完了!</Text>
          <Text style={s.body}>答对 {score.right}/{score.total}。新学的 {lesson.newItems.length} 个词已加入复习计划。</Text>
          <Button title="回到课程" onPress={() => router.back()} />
        </View>
      )}
    </ScrollView>
  );
}
