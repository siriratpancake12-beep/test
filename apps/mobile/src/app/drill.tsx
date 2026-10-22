import { Redirect, router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { finishDrill, recordAnswer, topWeakness, weaknessDrill } from "@lingo/core";
import { track } from "../analytics";
import { toAnswer } from "../answers";
import { Button } from "../components/Button";
import { ExerciseView } from "../components/ExerciseView";
import { getPack, itemPool } from "../content";
import { issueLabel } from "../labels";
import { useStore } from "../store";
import { s } from "../theme";

/** 弱点专练(会员):针对最近反复出现的错误类型,挑相关的、记得最差的词集中练。 */
export default function Drill() {
  const { lang, progress, premium, update } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  const [weak] = useState(() => (progress ? topWeakness(progress, new Date()) : undefined));
  const items = useMemo(() => (lang ? itemPool(lang) : []), [lang]);
  const exercises = useMemo(
    () => (weak && progress && pack ? weaknessDrill(weak.kind, progress, items, pack, new Date(), Date.now() % 100000) : []),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [i, setI] = useState(0);
  const [right, setRight] = useState(0);

  if (!premium) return <Redirect href="/paywall?reason=drill" />;
  if (!pack || !weak) return null;
  const ex = exercises[i];

  if (!ex) {
    return (
      <View style={[s.screen, s.pad]}>
        <View style={s.card}>
          <Text style={s.h1}>{exercises.length ? "专练完成" : "暂时没有可以专练的内容"}</Text>
          <Text style={s.body}>
            {exercises.length ? `「${issueLabel(weak.kind)}」答对 ${right}/${exercises.length}。坚持几天,这类错误会明显减少,周报里能看到变化。` : "学过的相关词还太少,多学几课再来。"}
          </Text>
          <Button title="回首页" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.sub}>弱点专练:{issueLabel(weak.kind)} · {i + 1}/{exercises.length}</Text>
      <ExerciseView ex={ex} pack={pack} item={"itemId" in ex ? items.find((x) => x.id === ex.itemId) : undefined} onDone={(r) => {
        const now = new Date();
        update((p) => {
          const next = recordAnswer(p, toAnswer(ex, r), now);
          return i + 1 >= exercises.length ? finishDrill(next, now) : next;
        });
        if (i + 1 >= exercises.length) track("drill_complete", { weakness: weak.kind, total: exercises.length, correct: right + (r.verdict === "wrong" ? 0 : 1) });
        if (r.verdict !== "wrong") setRight(right + 1);
        setI(i + 1);
      }} />
    </ScrollView>
  );
}
