import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  addStudyTime, canAccessLesson, completeLesson, isFreeLesson, lessonPractice, recordAnswer,
  type Answer, type Exercise, type Lesson, type Line, type Verdict,
} from "@lingo/core";
import { checkpointLessonId, unitCheckpoint, unitOfLesson } from "@lingo/core/src/checkpoint";
import { estimateLessonMinutes } from "@lingo/core/src/hours";
import { Button } from "../../components/Button";
import { Dialogue } from "../../components/Dialogue";
import { ExerciseView, type ExerciseResult } from "../../components/ExerciseView";
import { Passage } from "../../components/Passage";
import { QuestionCard } from "../../components/QuestionCard";
import { RolePlay } from "../../components/RolePlay";
import { Shadowing } from "../../components/Shadowing";
import { toAnswer } from "../../answers";
import { getLesson, getLessons, getPack, itemPool } from "../../content";
import { askNotifications, canAskNotifications } from "../../notify";
import { say, stopSpeaking } from "../../speech";
import { useStore } from "../../store";
import { color, s } from "../../theme";

/**
 * 一节课。流程按课的类型走,和 core 的 hours.ts 估算学习时长的步骤一一对应(时长是按这些步骤算出来的):
 * - 对话课:听课文(逐句、可点开中文)→ 理解题 → 生词 → 语法 → 练习 → 逐句跟读 → 角色扮演(两个人以上说话时)→ 完成
 * - 词汇课 / 语法课:听例句 → 理解题 → 生词 → 语法 → 练习 → 逐句跟读 → 完成
 * - 阅读课:读短文 → 理解题 → 生词 →(语法)→ 练习 → 精选 5 句跟读 → 完成
 * 理解题放在课文下面,听完马上答。跟读、角色扮演可以跳过(没有麦克风、不方便开口时),不会卡住。
 * 练习做完就算学完这课(建复习卡、记进度);后面的跟读和角色扮演中途退出,也不用把整课重学一遍。
 */
type Step = "text" | "words" | "grammar" | "practice" | "shadow" | "roleplay" | "done";

const STEP_ZH: Record<Step, string> = { text: "课文", words: "生词", grammar: "语法", practice: "练习", shadow: "跟读", roleplay: "角色扮演", done: "完成" };
/** 阅读课精选几句跟读(和 hours.ts 一致) */
const READER_SHADOW = 5;

/** 跟读哪几句:课文的每一句;阅读课从不太长的句子里均匀挑 5 句(开头、中间、结尾都有) */
function shadowLines(lesson: Lesson): Line[] {
  if (lesson.type !== "reading") return lesson.lines;
  const short = lesson.lines.filter((l) => l.text.length <= 80);
  const pool = short.length >= READER_SHADOW ? short : lesson.lines;
  if (pool.length <= READER_SHADOW) return pool;
  return Array.from({ length: READER_SHADOW }, (_, k) => pool[Math.round((k * (pool.length - 1)) / (READER_SHADOW - 1))]!);
}

const hasRoleplay = (l: Lesson) => l.type === "dialogue" && new Set(l.lines.map((x) => x.speaker)).size >= 2;

function stepsOf(l: Lesson, practice: number, shadow: number): Step[] {
  const steps: Step[] = [];
  if (l.lines.length || l.questions.length) steps.push("text");
  if (l.newItems.length) steps.push("words");
  if (l.grammar.length) steps.push("grammar");
  if (practice) steps.push("practice");
  if (shadow) steps.push("shadow");
  if (hasRoleplay(l)) steps.push("roleplay");
  return [...steps, "done"];
}

export default function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lesson = getLesson(id);
  const pack = lesson && getPack(lesson.lang);
  const { progress, premium, update } = useStore();
  const practice = useMemo<Exercise[]>(
    () => (lesson && pack ? lessonPractice(lesson, itemPool(lesson.lang), pack, Date.now() % 100000) : []),
    [lesson, pack],
  );
  const shadow = useMemo(() => (lesson ? shadowLines(lesson) : []), [lesson]);
  const steps = useMemo(() => (lesson ? stepsOf(lesson, practice.length, shadow.length) : (["done"] as Step[])), [lesson, practice.length, shadow.length]);
  const [step, setStep] = useState<Step>(steps[0]!);
  const [qi, setQi] = useState(0);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const [answered, setAnswered] = useState(0);
  const [askRemind, setAskRemind] = useState(false);
  // 进来时是不是一节课都没学过(学完第一课再问要不要提醒);练习做完就记"学完",所以要在进来时定下
  const [firstLessonEver] = useState(() => !!progress && Object.keys(progress.completed).length === 0);
  const stepStart = useRef(Date.now());
  const completed = useRef(false);
  const items = useMemo(() => new Map((lesson ? itemPool(lesson.lang) : []).map((i) => [i.id, i])), [lesson]);

  useEffect(() => {
    stepStart.current = Date.now();
  }, [step]);
  useEffect(() => () => stopSpeaking(), []);

  if (!lesson || !pack) return <Text style={s.body}>找不到这节课</Text>;
  const lessons = getLessons(lesson.lang);
  if (!canAccessLesson(lesson, lessons, premium, progress?.freeUnit)) return <Redirect href="/paywall?reason=lesson" />;
  const nextOne = lessons.find((l) => l.order > lesson.order);
  const unitFinished = !premium && isFreeLesson(lesson, lessons, progress?.freeUnit) && !!nextOne && !isFreeLesson(nextOne, lessons, progress?.freeUnit);
  const nextOf = (st: Step): Step => steps[steps.indexOf(st) + 1] ?? "done";

  const complete = () => {
    if (completed.current) return;
    completed.current = true;
    const now = new Date();
    update((p) => completeLesson(p, lesson, now));
  };

  /**
   * 进入下一步。看课文、生词、语法、跟读、角色扮演的时间按这一步停留的时长算学习时间
   * (这些步骤里记的答题不带用时,不会重复算);练习按每道题的用时算,这里不再加。
   */
  const advance = async (from: Step) => {
    const to = nextOf(from);
    if (from !== "practice") {
      const secs = (Date.now() - stepStart.current) / 1000;
      update((p) => addStudyTime(p, new Date(), secs));
    }
    if (from === "practice" || to === "done") complete();
    setStep(to);
    // 学完第一课、尝到甜头之后,再问要不要每天提醒
    if (to === "done" && firstLessonEver && (await canAskNotifications())) setAskRemind(true);
  };

  /** 理解题、跟读、角色扮演:没有对应的词条,按技能记(听 / 说) */
  const recordSkill = (skill: Answer["skill"], verdict: Verdict) => {
    const now = new Date();
    update((p) => recordAnswer(p, { skill, verdict }, now));
  };

  const answer = (ex: Exercise, r: ExerciseResult) => {
    const now = new Date();
    update((p) => recordAnswer(p, toAnswer(ex, r), now));
    setScore((sc) => ({ right: sc.right + (r.verdict === "wrong" ? 0 : 1), total: sc.total + 1 }));
    if (qi + 1 < practice.length) return setQi(qi + 1);
    void advance("practice");
  };

  const textNext = nextOf("text");
  const shownSteps = steps.filter((x) => x !== "done");
  const stepName = (st: Step) => (st !== "text" ? STEP_ZH[st] : lesson.type === "dialogue" ? "课文" : lesson.type === "reading" ? "短文" : "例句");
  // 这节课学完后整个单元都学完了:接着做单元练习(再去测评、拿证书)
  const unit = step === "done" ? unitOfLesson(lessons, lesson.id) : undefined;
  const unitReady = !!unit && !!progress && unitCheckpoint(progress, unit.lessons).ready && !unitCheckpoint(progress, unit.lessons).passed;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: lesson.titleZh }} />
      {step !== "done" && (
        <Text style={s.sub}>
          第 {shownSteps.indexOf(step) + 1}/{shownSteps.length} 步 · {stepName(step)}{step === "text" ? ` · 整课约 ${Math.round(estimateLessonMinutes(lesson))} 分钟` : ""}
        </Text>
      )}

      {step === "text" && (
        <>
          <Text style={s.sub}>🎯 {lesson.canDoZh}</Text>
          {lesson.lines.length > 0 && (lesson.type === "reading" ? <Passage lines={lesson.lines} pack={pack} /> : <Dialogue lines={lesson.lines} pack={pack} />)}
          {lesson.questions.length > 0 && (
            <>
              <Text style={s.h2}>{lesson.type === "reading" ? "读懂了吗?" : "听懂了吗?"}</Text>
              {lesson.questions.map((q, i) => (
                <QuestionCard key={i} q={q} n={i + 1} onAnswer={(ok) => {
                  setAnswered((a) => a + 1);
                  recordSkill("listen", ok ? "correct" : "wrong");
                }} />
              ))}
            </>
          )}
          <Button
            ghost={answered < lesson.questions.length}
            title={textNext === "words" ? "学生词" : textNext === "practice" ? "开始练习" : `下一步:${STEP_ZH[textNext]}`}
            onPress={() => void advance("text")}
          />
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
          <Button title="下一步" onPress={() => void advance("words")} />
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
          <Button title={nextOf("grammar") === "practice" ? "开始练习" : "下一步"} onPress={() => void advance("grammar")} />
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

      {step === "shadow" && (
        <Shadowing lines={shadow} pack={pack} onAnswer={(v) => recordSkill("speak", v)} onFinish={() => void advance("shadow")} />
      )}

      {step === "roleplay" && (
        <RolePlay lines={lesson.lines} pack={pack} onAnswer={(v) => recordSkill("speak", v)} onFinish={() => void advance("roleplay")} />
      )}

      {step === "done" && (
        <View style={s.card}>
          <Text style={s.h1}>🎉 学完了!</Text>
          <Text style={s.body}>✅ {lesson.canDoZh}</Text>
          <Text style={s.sub}>
            {score.total ? `练习答对 ${score.right}/${score.total}。` : ""}新学的 {lesson.newItems.length} 个词已加入复习计划,快忘的时候会提醒你复习。
          </Text>
          {askRemind && (
            <View style={[s.card, { borderColor: color.primary }]}>
              <Text style={s.body}>每天在你习惯的时间提醒你学几分钟?坚持比学多久更重要。</Text>
              <Button title="好,提醒我" onPress={async () => { await askNotifications(); setAskRemind(false); }} />
              <Button ghost title="不用了" onPress={() => setAskRemind(false)} />
            </View>
          )}
          {unitReady && unit && (
            <Button ghost title="📚 这个单元学完了,做单元练习" onPress={() => router.replace(`/checkpoint?lesson=${checkpointLessonId(unit.lessons)}&mode=practice`)} />
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
