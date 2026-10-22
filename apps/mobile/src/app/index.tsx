import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from "react-native";
import {
  canAccessLesson, dailyPlan, isDone, isUnlocked, levelProgress, nextLesson, projection, renewalReminder, streak, todayMinutes,
  type Block,
} from "@lingo/core";
import { serverEnabled } from "../api";
import { estimateLessonMinutes } from "@lingo/core/src/hours";
import { Button } from "../components/Button";
import { GoalReachedCard, UnitCheckpointCard } from "../components/UnitCards";
import { getLesson, getLessons, getPack } from "../content";
import { issueLabel, zhDate, zhMonth } from "../labels";
import { reschedule } from "../notify";
import { manageSubscriptionsUrl } from "../purchases";
import { useStore } from "../store";
import { color, s } from "../theme";

export default function Home() {
  const { ready, lang, progress, sub, premium, setLang, applySub } = useStore();
  const [showAll, setShowAll] = useState(false);
  const pack = lang ? getPack(lang) : undefined;
  const now = new Date();
  const reminder = renewalReminder(sub, now);

  // 回到首页时重新排提醒(学完一课、复习完都会回到这里)
  useFocusEffect(useCallback(() => {
    if (progress && pack) reschedule(progress, sub, `学${pack.nameZh}`).catch((e) => console.warn("排提醒失败", e));
  }, [progress, sub, pack]));
  // 扣费提醒在首页显示一次就记下,不重复打扰
  useEffect(() => {
    if (reminder) applySub([{ type: "reminded", key: reminder.key, at: new Date() }]);
  }, [reminder?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!lang || !progress || !pack || !progress.goal) return <Redirect href="/onboarding" />;

  const lessons = getLessons(lang);
  const plan = dailyPlan(progress, lessons, now, { premium, canAccess: (l) => canAccessLesson(l, lessons, premium, progress.freeUnit) });
  const pr = projection(progress, pack, lessons, now);
  const days = streak(progress, now);
  const mins = todayMinutes(progress, now);
  const goal = progress.goal.dailyMinutes;
  const upNext = nextLesson(lessons, progress);

  const open = (b: Block) => {
    if (b.kind === "review") return router.push("/review");
    if (b.locked) return router.push(`/paywall?reason=${b.kind}`);
    if (b.kind === "drill") return router.push("/drill");
    router.push(`/lesson/${b.lessonId}`);
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {reminder && (
        <View style={[s.card, { borderColor: color.warn }]}>
          <Text style={s.body}>{reminder.zh}</Text>
          <Text style={[s.sub, { color: color.primary }]} onPress={() => Linking.openURL(manageSubscriptionsUrl)}>管理订阅</Text>
        </View>
      )}

      <View style={s.card}>
        <Text style={s.h1}>{pack.nameZh} · 今天 {Math.min(mins, goal)}/{goal} 分钟{mins >= goal ? " ✅" : ""}</Text>
        <Text style={s.sub}>
          🔥 连续 {days} 天{progress.freezes ? ` · 🧊 保护卡 ${progress.freezes} 张(漏学一天自动使用)` : " · 连续学满 7 天送一张保护卡"}
        </Text>
      </View>

      {plan.notes.map((n) => (
        <Text key={n.code} style={[s.body, { color: color.primary }]}>{n.zh}</Text>
      ))}

      <Text style={s.h2}>今天的计划 · 约 {plan.minutes} 分钟</Text>
      {plan.blocks.map((b) => (
        <Pressable key={b.kind} onPress={() => open(b)} disabled={b.done && b.kind !== "lesson"} style={[s.card, { opacity: b.done ? 0.6 : 1 }]}>
          <Text style={s.h2}>{b.done ? "✅ " : "locked" in b && b.locked ? "🔒 " : ""}{blockTitle(b)}</Text>
          <Text style={s.sub}>{blockSub(b)} · {b.minutes} 分钟</Text>
        </Pressable>
      ))}
      <UnitCheckpointCard progress={progress} lessons={lessons} />
      {plan.blocks.every((b) => b.done) && plan.blocks.length > 0 && (
        <Text style={s.body}>🎉 今天的计划完成了!</Text>
      )}
      {upNext && plan.blocks.some((b) => b.kind === "lesson" && b.done) && (
        <Button
          ghost
          title={`${canAccessLesson(upNext, lessons, premium, progress.freeUnit) ? "" : "🔒 "}继续学下一课:${upNext.titleZh}`}
          onPress={() => router.push(canAccessLesson(upNext, lessons, premium, progress.freeUnit) ? `/lesson/${upNext.id}` : "/paywall?reason=lesson")}
        />
      )}

      <GoalReachedCard progress={progress} lessons={lessons} />
      {pr && (
        <Pressable onPress={() => router.push("/plan")} style={s.card}>
          <Text style={s.sub}>我的目标</Text>
          {pr.milestones.length > 1 && <Text style={s.body}>📍 下一站 {pr.milestones[0]!.level}:预计 {zhMonth(pr.milestones[0]!.etaDay)}</Text>}
          <Text style={s.h2}>🏁 {pr.target}:预计 {zhMonth(pr.etaDay)}</Text>
          {pr.onTrack === false && <Text style={[s.sub, { color: color.warn }]}>按期达到需要每天约 {pr.neededMinutes} 分钟,点这里调整</Text>}
          {levelProgress(progress, lessons).map((lp) => (
            <View key={lp.level} style={{ gap: 4 }}>
              <Text style={s.sub}>{lp.level} 课程 {lp.done}/{lp.total}</Text>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: color.line }}>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: color.primary, width: `${Math.round((lp.done / lp.total) * 100)}%` }} />
              </View>
            </View>
          ))}
        </Pressable>
      )}

      <Button ghost title="📊 本周学习报告" onPress={() => router.push("/report")} />
      <Button ghost title="🗣 AI 对话练习" onPress={() => router.push("/tutor")} />
      <Button ghost title="多复习一会儿" onPress={() => router.push("/review?extra=1")} />

      <Pressable onPress={() => setShowAll(!showAll)}>
        <Text style={s.h2}>全部课程 {showAll ? "▲" : "▼"}</Text>
      </Pressable>
      {showAll && lessons.map((l) => {
        const done = isDone(progress, l.id);
        const open = isUnlocked(lessons, progress, l.id);
        const locked = !canAccessLesson(l, lessons, premium, progress.freeUnit);
        return (
          <Pressable key={l.id} disabled={!open} onPress={() => router.push(locked ? "/paywall?reason=lesson" : `/lesson/${l.id}`)}
            style={[s.card, { opacity: open ? 1 : 0.45 }]}>
            <Text style={s.sub}>{l.cefr} · {l.unit}</Text>
            <Text style={s.h2}>{done ? "✅ " : locked ? "🔒 " : !open ? "⏳ " : ""}{l.titleZh}</Text>
            <Text style={s.sub}>{l.canDoZh} · 约 {Math.round(estimateLessonMinutes(l))} 分钟</Text>
          </Pressable>
        );
      })}

      <View style={{ gap: 8, marginTop: 8 }}>
        <Text style={s.sub}>
          {premium ? `${sub!.status === "trial" ? "试用" : "会员"}有效期至 ${zhDate(sub!.periodEnd.slice(0, 10))}` : "免费版:第一单元和全部复习免费"}
        </Text>
        {!premium && <Button ghost title="了解会员" onPress={() => router.push("/paywall?reason=plan")} />}
        <Button ghost title="调整学习目标" onPress={() => router.push("/onboarding")} />
        <Button ghost title="换一门语言" onPress={() => setLang(null)} />
        <SettingsEntry />
      </View>
    </ScrollView>
  );
}

function blockTitle(b: Block): string {
  if (b.kind === "review") return "复习";
  if (b.kind === "drill") return `弱点专练:${issueLabel(b.weakness)}`;
  return `新课:${getLesson(b.lessonId)?.titleZh ?? ""}`;
}

function blockSub(b: Block): string {
  if (b.kind === "review") return b.done ? "今天的复习做完了" : `${b.cards} 个词该巩固了`;
  if (b.kind === "drill") return "针对你最近常犯的错";
  return getLesson(b.lessonId)?.canDoZh ?? "";
}

/** 设置入口。配置了服务器又没登录时顺带说一句登录的好处(只提示,不强迫) */
function SettingsEntry() {
  const { user } = useStore();
  return (
    <>
      <Button ghost title="⚙️ 设置" onPress={() => router.push("/settings")} />
      {serverEnabled() && !user && <Text style={[s.sub, { textAlign: "center" }]}>登录后换手机不丢进度、多台设备同步</Text>}
    </>
  );
}
