import { router } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { SKILLS, weeklyReport } from "@lingo/core";
import { Button } from "../components/Button";
import { getLessons, getPack } from "../content";
import { SKILL_ZH } from "../labels";
import { useStore } from "../store";
import { color, s } from "../theme";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** 周报:这周学会了什么、学了多少、哪里进步了、接下来练什么。 */
export default function Report() {
  const { lang, progress, premium } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  if (!pack || !progress) return null;
  const r = weeklyReport(progress, getLessons(pack.code), new Date());
  const diff = r.minutes - r.prevMinutes;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.sub}>{r.from} — {r.to}</Text>

      <View style={s.card}>
        <Text style={s.h2}>这周你学会了</Text>
        {r.canDo.length ? r.canDo.map((c) => <Text key={c} style={s.body}>✅ {c}</Text>) : <Text style={s.sub}>这周还没有学完新课</Text>}
      </View>

      <View style={s.card}>
        <Text style={s.body}>学习 {r.activeDays} 天 · {r.minutes} 分钟{r.prevMinutes ? `(比上周${diff >= 0 ? "多" : "少"} ${Math.abs(diff)} 分钟)` : ""}</Text>
        <Text style={s.body}>新学 {r.newItems} 个词 · 现在能主动用的词 {r.activeWords} 个</Text>
        <Text style={s.body}>🔥 连续 {r.streak} 天</Text>
      </View>

      {premium ? (
        <>
          <View style={s.card}>
            <Text style={s.h2}>正确率 {pct(r.accuracy)}{r.prevAccuracy !== null ? `(上周 ${pct(r.prevAccuracy)})` : ""}</Text>
            <Text style={s.sub}>正确率保持在 75%–93% 学得最快:太高说明太简单,太低说明太难,每日计划会自动调整。</Text>
            {SKILLS.map((k) => (
              <Text key={k} style={s.body}>{SKILL_ZH[k]}:{pct(r.skills[k])}</Text>
            ))}
          </View>
          {r.improved && (
            <View style={[s.card, { borderColor: color.good }]}>
              <Text style={s.body}>👏「{r.improved.zh}」的错误从上周 {r.improved.lastWeek} 次降到 {r.improved.thisWeek} 次</Text>
            </View>
          )}
          {r.focus && (
            <View style={[s.card, { borderColor: color.warn }]}>
              <Text style={s.h2}>下周重点</Text>
              <Text style={s.body}>{r.focus.zh}</Text>
              <Button title="现在练一练" onPress={() => router.push("/drill")} />
            </View>
          )}
        </>
      ) : (
        <View style={s.card}>
          <Text style={s.body}>开通会员,查看听说读写各项能力、错误改善情况和下周重点。</Text>
          <Button title="了解会员" onPress={() => router.push("/paywall?reason=report")} />
        </View>
      )}
    </ScrollView>
  );
}
