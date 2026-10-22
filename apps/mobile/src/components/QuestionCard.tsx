import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { Question } from "@lingo/core";
import { color, s } from "../theme";

/**
 * 理解题:听完/读完课文后检查听懂了没有。选完马上告诉对错,答错时显示正确答案和中文解释(指出课文里哪一句)。
 * 每道题只能答一次(第一次的选择才说明听懂了没有)。
 */
export function QuestionCard({ q, n, onAnswer }: { q: Question; n: number; onAnswer: (correct: boolean) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const done = picked !== null;
  const right = picked === q.answer;
  const pick = (i: number) => {
    if (done) return;
    setPicked(i);
    Haptics.notificationAsync(i === q.answer ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error).catch(() => {});
    onAnswer(i === q.answer);
  };
  return (
    <View style={[s.card, done ? { borderColor: right ? color.good : color.bad } : null]}>
      <Text style={s.sub}>理解题 {n}</Text>
      <Text style={s.h2}>{q.prompt}</Text>
      {!!q.promptZh && <Text style={s.sub}>{q.promptZh}</Text>}
      {q.options.map((o, i) => (
        <Pressable
          key={`${i}-${o}`}
          accessibilityRole="button"
          disabled={done}
          onPress={() => pick(i)}
          style={[s.ghost, { paddingHorizontal: 12 }, done && i === q.answer ? { borderColor: color.good } : null, done && i === picked && !right ? { borderColor: color.bad } : null]}
        >
          <Text style={s.ghostText}>{o}</Text>
        </Pressable>
      ))}
      {done && (
        <Text style={[s.body, { color: right ? color.good : color.bad }]}>
          {right ? "✓ 答对了" : `正确答案:${q.options[q.answer] ?? ""}${q.explainZh ? `。${q.explainZh}` : ""}`}
        </Text>
      )}
    </View>
  );
}
