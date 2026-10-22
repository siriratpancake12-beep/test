import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { addStudyTime, canAccessLesson, completeLesson, isFreeLesson, lessonPractice, recordAnswer, type Exercise } from "@lingo/core";
import { Button } from "../../components/Button";
import { ExerciseView, type ExerciseResult } from "../../components/ExerciseView";
import { track } from "../../analytics";
import { toAnswer } from "../../answers";
import { getLesson, getLessons, getPack, itemPool } from "../../content";
import { askNotifications, canAskNotifications } from "../../notify";
import { say } from "../../speech";
import { useStore } from "../../store";
import { color, s } from "../../theme";

/** 一节课:对话 → 生词 → 语法 → 练习 → 完成。 */
type Step = "dialogue" | "words" | "grammar" | "practice" | "done";

export default function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lesson = getLesson(id);
  const pack = lesson && getPack(lesson.lang);
  const { progress, premium, update } = useStore();
  const [step, setStep] = useState<Step>(lesson?.lines.length ? "dialogue" : "words");
  const [showZh, setShowZh] = useState<Record<number, boolean>>({});
  const [qi, setQi] = useState(0);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const [askRemind, setAskRemind] = useState(false);
  const stepStart = useRef(Date.now());
  const practice = useMemo<Exercise[]>(
    () => (lesson && pack ? lessonPractice(lesson, itemPool(lesson.lang), pack, Date.now() % 100000) : []),
    [lesson, pack],
  );
  const items = useMemo(() => new Map((lesson ? itemPool(lesson.lang) : []).map((i) => [i.id, i])), [lesson]);

  // 看对话、生词、语法的时间也算学习时间(练习的时间按每道题算)
  useEffect(() => {
    stepStart.current = Date.now();
  }, [step]);
  useEffect(() => {
    if (lesson && canAccessLesson(lesson, getLessons(lesson.lang), premium, progress?.freeUnit)) track("lesson_start", { lessonId: lesson.id });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (next: Step) => {
    const secs = (Date.now() - stepStart.current) / 1000;
    update((p) => addStudyTime(p, new Date(), secs));
    setStep(next);
  };

  if (!lesson || !pack) return <Text style={s.body}>找不到这节课</Text>;
  const lessons = getLessons(lesson.lang);
  if (!canAccessLesson(lesson, lessons, premium, progress?.freeUnit)) return <Redirect href="/paywall?reason=lesson" />;
  const firstLessonEver = progress && Object.keys(progress.completed).length === 0;
  const nextOne = lessons.find((l) => l.order > lesson.order);
  const unitFinished = !premium && isFreeLesson(lesson, lessons, progress?.freeUnit) && !!nextOne && !isFreeLesson(nextOne, lessons, progress?.freeUnit);

  const answer = async (ex: Exercise, r: ExerciseResult) => {
    const now = new Date();
    update((p) => recordAnswer(p, toAnswer(ex, r), now));
    setScore((sc) => ({ right: sc.right + (r.verdict === "wrong" ? 0 : 1), total: sc.total + 1 }));
    if (qi + 1 < practice.length) return setQi(qi + 1);
    update((p) => completeLesson(p, lesson, now));
    track("lesson_complete", { lessonId: lesson.id, correct: score.right + (r.verdict === "wrong" ? 0 : 1), total: score.total + 1 });
    setStep("done");
    // 学完第一课、尝到甜头之后,再问要不要每天提醒
    if (firstLessonEver && (await canAskNotifications())) setAskRemind(true);
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Stack.Screen options={{ title: lesson.titleZh }} />
      {step === "dialogue" && (
        <>
          <Text style={s.sub}>🎯 {lesson.canDoZh}</Text>
          <Text style={s.sub}>点句子听发音,长按看中文</Text>
          {lesson.lines.map((l, i) => (
            <Pressable key={i} onPress={() => say(l.text, pack.locale)} onLongPress={() => setShowZh({ ...showZh, [i]: !showZh[i] })} style={s.card}>
              <Text style={s.sub}>{l.speaker}</Text>
              <Text style={s.target}>{l.text}</Text>
              {showZh[i] && <Text style={s.sub}>{l.zh}</Text>}
            </Pressable>
          ))}
          <Button title="学生词" onPress={() => go("words")} />
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
          <Button title="下一步" onPress={() => go(lesson.grammar.length ? "grammar" : "practice")} />
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
          <Button title="开始练习" onPress={() => go("practice")} />
        </>
      )}

      {step === "practice" && practice[qi] && (
        <>
          <Text style={s.sub}>练习 {qi + 1}/{practice.length}</Text>
          <ExerciseView
            ex={practice[qi]!}
            pack={pack}
            item={"itemId" in practice[qi]! ? items.get((practice[qi] as { itemId: string }).itemId) : undefined}
            onDone={(r) => answer(practice[qi]!, r)}
          />
        </>
      )}

      {step === "done" && (
        <View style={s.card}>
          <Text style={s.h1}>🎉 学完了!</Text>
          <Text style={s.body}>✅ {lesson.canDoZh}</Text>
          <Text style={s.sub}>答对 {score.right}/{score.total}。新学的 {lesson.newItems.length} 个词已加入复习计划,快忘的时候会提醒你复习。</Text>
          {askRemind && (
            <View style={[s.card, { borderColor: color.primary }]}>
              <Text style={s.body}>每天在你习惯的时间提醒你学几分钟?坚持比学多久更重要。</Text>
              <Button title="好,提醒我" onPress={async () => { track("notification_prompt", { granted: await askNotifications() }); setAskRemind(false); }} />
              <Button ghost title="不用了" onPress={() => setAskRemind(false)} />
            </View>
          )}
          {unitFinished ? (
            <>
              <Button title="继续学下一单元" onPress={() => router.replace("/paywall?reason=unit")} />
              <Button ghost title="回首页" onPress={() => router.back()} />
            </>
          ) : (
            <Button title="回首页" onPress={() => router.back()} />
          )}
        </View>
      )}
    </ScrollView>
  );
}
