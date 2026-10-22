import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import { GOAL_KINDS, levelProgress, projection, setGoal } from "@lingo/core";
import { track } from "../analytics";
import { Button } from "../components/Button";
import { getLessons, getPack } from "../content";
import { zhDate, zhMonth } from "../labels";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * 学习计划:告诉学习者"按每天 X 分钟,预计哪天达到目标"。
 * 目标不现实时直接说,并给出需要的每日时长——一开始就把期望对齐,后面才不会失望。
 */
/** 每天超过 2 小时不现实,不建议 */
const MAX_DAILY = 120;

export default function Plan() {
  const { first } = useLocalSearchParams<{ first?: string }>();
  const { lang, progress, premium, update } = useStore();
  useEffect(() => track("plan_view", { first: !!first }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const pack = lang ? getPack(lang) : undefined;
  if (!pack || !progress?.goal) return null;
  const lessons = getLessons(pack.code);
  const pr = projection(progress, pack, lessons, new Date())!;
  const goal = progress.goal;
  const kind = GOAL_KINDS.find((g) => g.kind === goal.kind)?.zh ?? "";
  const skipped = progress.skipped.length;
  const firstLevel = levelProgress(progress, lessons).find((l) => l.done < l.total);
  // 建议的每日时长取到 5 分钟的整数
  const suggested = Math.ceil((pr.neededMinutes ?? 0) / 5) * 5;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={s.card}>
        <Text style={s.sub}>{pack.nameZh} · {kind}</Text>
        <Text style={s.h1}>目标 {goal.target}</Text>
        <Text style={s.body}>
          每天 {goal.dailyMinutes} 分钟,预计 <Text style={{ fontWeight: "700", color: color.primary }}>{zhMonth(pr.etaDay)}</Text>达到 {goal.target}
        </Text>
        {pr.milestones.length > 1 && (
          <View style={{ gap: 2 }}>
            {pr.milestones.map((m) => (
              <Text key={m.level} style={s.sub}>{m.level === goal.target ? "🏁" : "📍"} {m.level}:{zhMonth(m.etaDay)}</Text>
            ))}
          </View>
        )}
        <Text style={s.sub}>
          从零到 {goal.target} 大约需要 {pr.totalHours} 小时{pr.doneHours >= 1 ? `,你已经有约 ${Math.round(pr.doneHours)} 小时的基础` : ""}。
          {pr.basedOnHistory ? "预估按你最近两周的实际学习时间计算。" : "开始学习后,会按你的实际进度更新。"}
        </Text>
      </View>

      {pr.daysLeft !== undefined && (
        <View style={[s.card, { borderColor: pr.onTrack ? color.good : color.warn }]}>
          {pr.onTrack ? (
            <Text style={s.body}>✅ 按这个节奏,能在期限({zhDate(goal.deadline!)})前达到目标。</Text>
          ) : (
            <>
              <Text style={s.body}>⚠️ 要在 {zhDate(goal.deadline!)} 前达到 {goal.target},每天需要学约 {pr.neededMinutes} 分钟。</Text>
              {suggested <= MAX_DAILY ? (
                <Button title={`改成每天 ${suggested} 分钟`} onPress={() => {
                  update((p) => setGoal(p, { ...goal, dailyMinutes: suggested }));
                  track("goal_change", { target: goal.target, dailyMinutes: suggested });
                }} />
              ) : (
                <Text style={s.sub}>这个期限太紧了。建议先把目标定在低一级,达到后再继续往上。</Text>
              )}
            </>
          )}
        </View>
      )}

      <View style={s.card}>
        <Text style={s.h2}>每天的安排</Text>
        <Text style={s.body}>① 复习:在快要忘的时候巩固学过的词(最省力的记忆方式)</Text>
        <Text style={s.body}>② 弱点专练:针对你最常犯的错误,比如冠词、重音符号</Text>
        <Text style={s.body}>③ 新课:对话 → 生词 → 语法 → 练习,每节课都有明确的"学完能做什么"</Text>
        <Text style={s.sub}>每周给你一份报告:这周学会了什么、能主动用多少词、哪个错误改掉了。</Text>
      </View>

      {skipped > 0 && <Text style={s.sub}>分级测试帮你跳过了 {skipped} 节已经会的课{firstLevel ? `,从 ${firstLevel.level} 开始` : ""}。</Text>}

      {first && !premium ? (
        <>
          <Button title="免费试用 7 天,解锁完整计划" onPress={() => router.push("/paywall?reason=plan")} />
          <Button ghost title="先免费学第一单元" onPress={() => router.replace("/")} />
        </>
      ) : first ? (
        <Button title="开始今天的学习" onPress={() => router.replace("/")} />
      ) : (
        <Button ghost title="调整目标" onPress={() => router.push("/onboarding")} />
      )}
    </ScrollView>
  );
}
