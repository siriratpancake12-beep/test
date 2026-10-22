import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, Text } from "react-native";
import { applyPlacement, levelPassed, placementLevels, placementQuestions, type Cefr } from "@lingo/core";
import { track } from "../analytics";
import { ExerciseView } from "../components/ExerciseView";
import { getLessons, getPack } from "../content";
import { useStore } from "../store";
import { color, s } from "../theme";

/** 分级测试:一级一级往上考,某一级没过就从那一级开始学。 */
export default function Placement() {
  const { lang, update } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  const lessons = lang ? getLessons(lang) : [];
  const levels = useMemo(() => placementLevels(lessons), [lessons]);
  const [li, setLi] = useState(0);
  const [qi, setQi] = useState(0);
  const [correct, setCorrect] = useState(0);
  const questions = useMemo(() => (pack && levels[li] ? placementQuestions(lessons, pack, levels[li]!, li + 1) : []), [pack, lessons, levels, li]);

  if (!pack) return null;

  const done = (passed: Cefr[]) => {
    update((p) => applyPlacement(p, lessons, passed, new Date()));
    router.replace("/plan?first=1");
  };

  const next = (ok: boolean) => {
    const c = correct + (ok ? 1 : 0);
    if (qi + 1 < questions.length) {
      setCorrect(c);
      setQi(qi + 1);
      return;
    }
    // 这一级考完
    if (!levelPassed(c, questions.length)) {
      track("placement_complete", { passedLevels: levels.slice(0, li).join(","), questions: questions.length, correct: c });
      return done(levels.slice(0, li));
    }
    if (li + 1 >= levels.length) {
      track("placement_complete", { passedLevels: levels.join(","), questions: questions.length, correct: c });
      return done(levels);
    }
    setLi(li + 1);
    setQi(0);
    setCorrect(0);
  };

  const q = questions[qi];
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.sub}>{levels[li]} · 第 {qi + 1}/{questions.length} 题 · 不会就选最像的,不用猜太久</Text>
      {q && <ExerciseView ex={q} pack={pack} onDone={(r) => next(r.verdict !== "wrong")} />}
      <Text style={[s.sub, { color: color.primary, marginTop: 24, textAlign: "center" }]} onPress={() => {
        track("placement_complete", { passedLevels: levels.slice(0, li).join(","), questions: qi, correct });
        done(levels.slice(0, li));
      }}>
        后面的都不会了,结束测试
      </Text>
    </ScrollView>
  );
}
