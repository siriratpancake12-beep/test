import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { canAccessLesson, isDone, isUnlocked, type Lesson, type Progress } from "@lingo/core";
import { courseUnits, unitLabel, type CourseUnit } from "@lingo/core/src/checkpoint";
import { estimateLessonMinutes } from "@lingo/core/src/hours";
import { color, s } from "../theme";

/**
 * 首页的"全部课程":按单元分组,一次只展开一个单元(默认是正在学的那个),点单元标题展开或收起。
 * 课程写满以后一门语言 500 多节课、50 个单元,一次渲染几百张卡片手机上会卡;
 * 现在只渲染单元标题和展开的那个单元里的十来节课。
 */
export function CourseList({ lessons, progress, premium, current }: {
  lessons: Lesson[];
  progress: Progress;
  premium: boolean;
  /** 默认展开的单元(下一节要学的课所在的单元) */
  current?: string;
}) {
  const units = useMemo(() => courseUnits(lessons), [lessons]);
  const [open, setOpen] = useState<string | null>(current ?? units[0]?.unit ?? null);
  return (
    <View style={{ gap: 12 }}>
      {units.map((u) => {
        const expanded = open === u.unit;
        return (
          <View key={u.unit} style={{ gap: 12 }}>
            <UnitHeader unit={u} progress={progress} expanded={expanded} onPress={() => setOpen(expanded ? null : u.unit)} />
            {expanded && u.lessons.map((l) => <LessonRow key={l.id} lesson={l} lessons={lessons} progress={progress} premium={premium} />)}
          </View>
        );
      })}
    </View>
  );
}

function UnitHeader({ unit, progress, expanded, onPress }: { unit: CourseUnit; progress: Progress; expanded: boolean; onPress: () => void }) {
  const { code, theme } = unitLabel(unit.unit);
  const done = unit.lessons.filter((l) => isDone(progress, l.id)).length;
  const all = done === unit.lessons.length;
  return (
    <Pressable testID="unit-header" accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress}
      style={[s.card, { flexDirection: "row", alignItems: "center", gap: 8 }, expanded ? { borderColor: color.primary } : null]}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={s.h2}>{all ? "✅ " : ""}{code} {theme}</Text>
        <Text style={s.sub}>{unit.lessons.length} 节课 · {all ? "学完了" : `学完 ${done} 节`}</Text>
      </View>
      <Text style={s.sub}>{expanded ? "▲" : "▼"}</Text>
    </Pressable>
  );
}

function LessonRow({ lesson: l, lessons, progress, premium }: { lesson: Lesson; lessons: Lesson[]; progress: Progress; premium: boolean }) {
  const done = isDone(progress, l.id);
  const open = isUnlocked(lessons, progress, l.id);
  const locked = !canAccessLesson(l, lessons, premium, progress.freeUnit);
  return (
    <Pressable testID="course-lesson" disabled={!open} onPress={() => router.push(locked ? "/paywall?reason=lesson" : `/lesson/${l.id}`)}
      style={[s.card, { marginLeft: 12, opacity: open ? 1 : 0.45 }]}>
      <Text style={s.h2}>{done ? "✅ " : locked ? "🔒 " : !open ? "⏳ " : ""}{l.titleZh}</Text>
      <Text style={s.sub}>{l.canDoZh} · 约 {Math.round(estimateLessonMinutes(l))} 分钟</Text>
    </Pressable>
  );
}
