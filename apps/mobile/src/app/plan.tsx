import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { GOAL_KINDS, isDone, levelProgress, projection, setGoal, type Goal } from "@lingo/core";
import { checkpointLessonId, courseUnits, goalReached, nextGoals, unitCheckpoint, unitLabel } from "@lingo/core/src/checkpoint";
import { track } from "../analytics";
import { Button } from "../components/Button";
import { Option } from "../components/Option";
import { getLessons, getPack } from "../content";
import { zhDate, zhMonth } from "../labels";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * 学习计划:告诉学习者"按每天 X 分钟,预计哪天达到目标"。
 * 目标不现实时直接说,并给出需要的每日时长——一开始就把期望对齐,后面才不会失望。
 * 达到目标时当场庆祝并建议下一个目标(下一个等级或考试方向),一键进入目标设定,避免"目标达成 = 不学了"。
 * 下面列出各单元的测评和证书,进步看得见。
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
  const reached = goalReached(progress, lessons);
  const suggestions = reached ? nextGoals(goal, pack) : [];
  const units = courseUnits(lessons);
  // 新用户引导完第一次看计划;老学员改完目标回来(也带 first)不再当新用户
  const newcomer = !!first && Object.keys(progress.completed).length === 0;

  /** 选了下一个目标:先存下来(每天时长不变、期限去掉),再进目标设定页细调,当前的选择会带过去 */
  const pickNext = (g: Goal) => {
    update((p) => setGoal(p, g));
    track("goal_change", { target: g.target, dailyMinutes: g.dailyMinutes });
    router.push({ pathname: "/onboarding", params: { from: "next-goal", target: g.target, kind: g.kind, ...(g.exam ? { exam: g.exam } : {}) } });
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {reached && (
        <View style={[s.card, { borderColor: color.good, borderWidth: 2 }]}>
          <Text style={s.h1}>🎉 目标 {goal.target} 达成!</Text>
          <Text style={s.body}>
            你做到了自己定的目标:一共学完 {Object.keys(progress.completed).length} 节课、学过 {Object.keys(progress.learned).length} 个词。学会了什么,单元证书里都写着。
          </Text>
          {suggestions.length ? (
            <>
              <Text style={s.h2}>下一个目标</Text>
              {suggestions.map((sg) => (
                <Option key={sg.titleZh} title={sg.titleZh} sub={sg.subZh} onPress={() => pickNext(sg.goal)} />
              ))}
              <Text style={s.sub}>选好以后可以再调整每天的时长和期限。</Text>
            </>
          ) : (
            <Text style={s.body}>你已经达到最高等级了!保持每天复习,把学会的用起来。</Text>
          )}
        </View>
      )}

      <View style={s.card}>
        <Text style={s.sub}>{pack.nameZh} · {kind}{goal.exam ? ` · ${goal.exam}` : ""}</Text>
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
        <Text style={s.body}>③ 新课:课文 → 理解题 → 生词 → 语法 → 练习 → 跟读,每节课都有明确的"学完能做什么"</Text>
        <Text style={s.body}>④ 学完一个单元:单元练习 → 单元测评,80 分发单元证书</Text>
        <Text style={s.sub}>每周给你一份报告:这周学会了什么、能主动用多少词、哪个错误改掉了。</Text>
      </View>

      {units.length > 0 && (
        <View style={s.card}>
          <Text style={s.h2}>单元测评和证书</Text>
          {units.map((u) => {
            const st = unitCheckpoint(progress, u.lessons);
            const done = u.lessons.filter((l) => isDone(progress, l.id)).length;
            const { code, theme } = unitLabel(u.unit);
            const at = checkpointLessonId(u.lessons);
            return (
              <Pressable key={u.unit} disabled={!st.ready && !st.passed} onPress={() => router.push(st.passed ? `/certificate?lesson=${at}` : `/checkpoint?lesson=${at}`)}
                style={{ paddingVertical: 6, gap: 2, opacity: st.ready || st.passed ? 1 : 0.5 }}>
                <Text style={s.body}>{st.passed ? "🏅" : st.ready ? "📝" : "⏳"} {code} {theme}</Text>
                <Text style={s.sub}>
                  {st.passed
                    ? `${st.best!.score} 分 · ${zhDate(st.best!.day)} · 查看证书`
                    : st.ready
                      ? st.last ? `上次 ${st.last.score} 分,可以再测` : "课学完了,可以测评"
                      : `课程 ${done}/${u.lessons.length},学完后开放测评`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {skipped > 0 && <Text style={s.sub}>分级测试帮你跳过了 {skipped} 节已经会的课{firstLevel ? `,从 ${firstLevel.level} 开始` : ""}。</Text>}

      {newcomer && !premium ? (
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
