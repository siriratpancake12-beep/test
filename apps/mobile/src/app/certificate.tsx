import Constants from "expo-constants";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, Share, Text, View } from "react-native";
import { checkpointLessonId, unitCheckpoint, unitLabel, unitOfLesson } from "@lingo/core/src/checkpoint";
import { Button } from "../components/Button";
import { getLessons, getPack } from "../content";
import { zhDate } from "../labels";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * 单元证书:通过单元测评后发。写清楚学会了什么(各课的 canDoZh),而不只是一个分数——
 * 给学习者自己看"这个单元我能做什么了",也可以用系统分享发给朋友(朋友圈传播的入口)。
 * 参数 lesson 是这个单元里任意一课的 id;显示最好的一次成绩。
 */
const APP_NAME = Constants.expoConfig?.name ?? "语途";

export default function Certificate() {
  const { lesson } = useLocalSearchParams<{ lesson?: string }>();
  const { lang, progress } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  const lessons = lang ? getLessons(lang) : [];
  const unit = useMemo(() => unitOfLesson(lessons, lesson), [lessons, lesson]);
  const [shareFailed, setShareFailed] = useState(false);

  if (!pack || !progress) return null;
  const st = unit && unitCheckpoint(progress, unit.lessons);
  if (!unit || !st?.passed || !st.best) {
    return (
      <View style={[s.screen, s.pad]}>
        <View style={s.card}>
          <Text style={s.h2}>还没有这个单元的证书</Text>
          <Text style={s.body}>单元测评 80 分以上就能拿到证书。</Text>
          {unit && <Button title="去测评" onPress={() => router.replace(`/checkpoint?lesson=${checkpointLessonId(unit.lessons)}`)} />}
        </View>
      </View>
    );
  }

  const { code, theme } = unitLabel(unit.unit);
  const canDo = [...new Set(unit.lessons.map((l) => l.canDoZh))];
  const date = zhDate(st.best.day);
  const message = [
    `我在「${APP_NAME}」完成了${pack.nameZh} ${code} 单元${theme ? `「${theme}」` : ""},单元测评 ${st.best.score} 分!`,
    "这个单元学会了:",
    ...canDo.map((c) => `✅ ${c}`),
    date,
  ].join("\n");

  const share = async () => {
    try {
      await Share.share({ message, title: `${pack.nameZh} ${code} 单元证书` });
    } catch {
      // 网页预览、不支持系统分享的设备:把文字显示出来,让学习者自己复制
      setShareFailed(true);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Stack.Screen options={{ title: `${code} 单元证书` }} />
      <View style={[s.card, { borderColor: color.primary, borderWidth: 2, alignItems: "center", paddingVertical: 24 }]}>
        <Text style={s.sub}>{APP_NAME} · {pack.nameZh}</Text>
        <Text style={{ fontSize: 48 }}>🏅</Text>
        <Text style={[s.h1, { textAlign: "center" }]}>完成 {code} 单元</Text>
        {!!theme && <Text style={[s.h2, { textAlign: "center" }]}>「{theme}」</Text>}
        <Text style={[s.body, { textAlign: "center" }]}>
          {st.best.score} 分 · {date}
        </Text>
        <View style={{ alignSelf: "stretch", height: 1, backgroundColor: color.line, marginVertical: 8 }} />
        <Text style={[s.h2, { alignSelf: "flex-start" }]}>这个单元学会了</Text>
        {canDo.map((c) => (
          <Text key={c} style={[s.body, { alignSelf: "flex-start" }]}>✅ {c}</Text>
        ))}
      </View>
      <Button title="分享给朋友" onPress={share} />
      {shareFailed && (
        <View style={s.card}>
          <Text style={s.sub}>这里不能直接分享,可以长按复制下面的文字:</Text>
          <Text selectable style={s.body}>{message}</Text>
        </View>
      )}
      <Button ghost title="回首页" onPress={() => router.dismissTo("/")} />
    </ScrollView>
  );
}
