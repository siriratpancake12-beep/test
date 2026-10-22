import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { todayOf, type Lesson, type Progress } from "@lingo/core";
import { checkpointLessonId, goalReached, pendingCheckpoint, unitCheckpoint, unitLabel, type CourseUnit } from "@lingo/core/src/checkpoint";
import { MINUTES } from "@lingo/core/src/hours";
import { storage } from "../storage";
import { color, s } from "../theme";

/**
 * 首页上和单元、目标有关的卡片:单元练习 → 单元测评(出现在"今天的计划"里)、目标达成。
 * 首页只放入口;做题在 /checkpoint(练习用 mode=practice),证书在 /certificate,下一个目标在 /plan。
 */

/** 单元练习、单元测评大约几分钟(题数 × 每题平均用时,取到 5 分钟) */
export const unitMinutes = (questions: number) => Math.max(5, Math.round((questions * MINUTES.exercise) / 5) * 5);
export const UNIT_PRACTICE_SIZE = 25;
const UNIT_TEST_SIZE = 15;

// 单元练习不计分,只在首页打勾,所以只记在本机:单元的第一课 → 最近一次练完的日子
const practiceKey = (lang: string) => `unitPractice:${lang}`;
export const unitKey = (u: CourseUnit) => u.lessons[0]?.id ?? u.unit;

async function readPractice(lang: string): Promise<Record<string, string>> {
  try {
    const raw = await storage.getItem(practiceKey(lang));
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function markUnitPractice(lang: string, u: CourseUnit, day: string) {
  const cur = await readPractice(lang);
  await storage.setItem(practiceKey(lang), JSON.stringify({ ...cur, [unitKey(u)]: day })).catch(() => {});
}

/** 每次回到页面重新读(做完练习回首页时打勾) */
function usePracticeDays(lang: string): Record<string, string> {
  const [days, setDays] = useState<Record<string, string>>({});
  useFocusEffect(useCallback(() => {
    let alive = true;
    readPractice(lang).then((d) => alive && setDays(d));
    return () => {
      alive = false;
    };
  }, [lang]));
  return days;
}

/**
 * "今天的计划"里的单元练习和单元测评:一个单元的课全部学完、还没通过测评时出现。
 * 先练(约 10 分钟、不计分),再测(80 分发证书);今天练过的打勾,今天测过没通过的提示复习后再试。
 */
export function UnitCheckpointCard({ progress, lessons }: { progress: Progress; lessons: Lesson[] }) {
  const unit = pendingCheckpoint(progress, lessons);
  const days = usePracticeDays(progress.lang);
  if (!unit) return null;
  const st = unitCheckpoint(progress, unit.lessons);
  const today = todayOf(progress, new Date());
  const practiced = days[unitKey(unit)] === today;
  const triedToday = st.last?.day === today;
  const { code, theme } = unitLabel(unit.unit);
  const lessonId = checkpointLessonId(unit.lessons);
  return (
    <View style={{ gap: 12 }}>
      <Pressable onPress={() => router.push(`/checkpoint?lesson=${lessonId}&mode=practice`)} style={[s.card, { opacity: practiced ? 0.6 : 1 }]}>
        <Text style={s.h2}>{practiced ? "✅ " : ""}单元练习:{code} {theme}</Text>
        <Text style={s.sub}>{practiced ? "今天练过了,可以去测评了" : "这个单元学完了!把整个单元的词和句子再练一遍"} · {unitMinutes(UNIT_PRACTICE_SIZE)} 分钟</Text>
      </Pressable>
      <Pressable onPress={() => router.push(`/checkpoint?lesson=${lessonId}`)} style={[s.card, { opacity: triedToday ? 0.6 : 1 }]}>
        <Text style={s.h2}>单元测评:{code} {theme}</Text>
        <Text style={s.sub}>
          {triedToday ? `今天 ${st.last!.score} 分,复习一下再来` : st.last ? `上次 ${st.last.score} 分,80 分拿单元证书` : "80 分拿单元证书"} · {unitMinutes(UNIT_TEST_SIZE)} 分钟
        </Text>
      </Pressable>
    </View>
  );
}

/** 目标达成:当场庆祝,并引导去学习计划页定下一个目标(避免"目标达成 = 不学了 = 退订")。 */
export function GoalReachedCard({ progress, lessons }: { progress: Progress; lessons: Lesson[] }) {
  if (!progress.goal || !goalReached(progress, lessons)) return null;
  return (
    <Pressable onPress={() => router.push("/plan")} style={[s.card, { borderColor: color.good, borderWidth: 2 }]}>
      <Text style={s.h2}>🎉 目标 {progress.goal.target} 达成!</Text>
      <Text style={s.body}>你做到了自己定的目标。接下来往哪走?</Text>
      <Text style={[s.sub, { color: color.primary }]}>设定下一个目标 →</Text>
    </Pressable>
  );
}
