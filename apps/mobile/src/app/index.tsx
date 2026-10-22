import { router } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { isUnlocked, streak, todaysReview } from "@lingo/core";
import { Button } from "../components/Button";
import { availableLangs, comingSoonLangs, getLessons, getPack } from "../content";
import { useStore } from "../store";
import { color, s } from "../theme";

export default function Home() {
  const { ready, lang, progress, setLang } = useStore();
  if (!ready) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!lang || !progress || !getPack(lang)) return <LanguagePicker onPick={setLang} />;

  const pack = getPack(lang)!;
  const lessons = getLessons(lang);
  const now = new Date();
  const reviewCount = todaysReview(progress, now).length;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={s.card}>
        <Text style={s.h1}>{pack.nameZh} · {pack.nativeName}</Text>
        <Text style={s.sub}>连续学习 {streak(progress, now)} 天 · 已学 {progress.completedLessons.length}/{lessons.length} 课</Text>
        <Button title={reviewCount ? `今日复习(${reviewCount})` : "今天没有要复习的"} disabled={!reviewCount} onPress={() => router.push("/review")} />
      </View>

      {lessons.map((l) => {
        const done = progress.completedLessons.includes(l.id);
        const open = isUnlocked(lessons, progress, l.id);
        return (
          <Pressable key={l.id} disabled={!open} onPress={() => router.push(`/lesson/${l.id}`)}
            style={[s.card, { opacity: open ? 1 : 0.45 }]}>
            <Text style={s.sub}>{l.cefr} · {l.unit}</Text>
            <Text style={s.h2}>{done ? "✅ " : open ? "" : "🔒 "}{l.titleZh}</Text>
            <Text style={s.sub}>{l.goalZh} · 约 {l.estimatedMinutes} 分钟</Text>
          </Pressable>
        );
      })}

      <Button ghost title="换一门语言" onPress={() => setLang(null)} />
    </ScrollView>
  );
}

function LanguagePicker({ onPick }: { onPick: (code: string) => void }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>你想学哪门语言?</Text>
      {availableLangs().map((p) => (
        <Pressable key={p.code} onPress={() => onPick(p.code)} style={s.card}>
          <Text style={s.h2}>{p.nameZh} · {p.nativeName}</Text>
          <Text style={s.sub}>考试方向:{p.examsZh.join("、")}</Text>
        </Pressable>
      ))}
      <Text style={[s.sub, { marginTop: 8 }]}>即将上线</Text>
      {comingSoonLangs().map((p) => (
        <View key={p.code} style={[s.card, { opacity: 0.5 }]}>
          <Text style={s.h2}>{p.nameZh} · {p.nativeName}</Text>
        </View>
      ))}
      <Text style={[s.sub, { color: color.sub }]}>可以随时在首页切换语言,各语言进度分开保存。</Text>
    </ScrollView>
  );
}
