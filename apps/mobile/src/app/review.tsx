import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { exerciseFor, finishReview, recordAnswer, reviewCap, todaysReview } from "@lingo/core";
import { toAnswer } from "../answers";
import { Button } from "../components/Button";
import { ExerciseView } from "../components/ExerciseView";
import { getPack, itemPool } from "../content";
import { useStore } from "../store";
import { s } from "../theme";

/**
 * 复习:到期的卡 + 新卡,每张按方向出题(认读/听力/产出)。永远免费。
 * 一次的量按每日计划封顶;想多练可以从首页"多复习一会儿"进来(extra)。
 */
export default function Review() {
  const { extra } = useLocalSearchParams<{ extra?: string }>();
  const { lang, progress, update } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  const pool = useMemo(() => (lang ? itemPool(lang) : []), [lang]);
  // 进入页面时定下这次的题单,答题过程中不再变化;课程下架的词条跳过
  const queue = useMemo(() => {
    if (!progress) return [];
    const now = new Date();
    const cap = extra ? 30 : reviewCap(progress, now);
    return todaysReview(progress, now, cap).filter((c) => pool.some((x) => x.id === c.itemId));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [i, setI] = useState(0);
  const [right, setRight] = useState(0);
  const card = queue[i];
  const item = card && pool.find((x) => x.id === card.itemId);
  // 题目对象要稳定:重新渲染时换了新对象,题目会被重置
  const ex = useMemo(() => (card && item && pack ? exerciseFor(item, card.direction, pool, pack, i + 1) : null), [card, item, pack, pool, i]);

  if (!pack) return null;
  if (!card || !item || !ex) {
    return (
      <View style={[s.screen, s.pad]}>
        <View style={s.card}>
          <Text style={s.h1}>复习完成</Text>
          <Text style={s.body}>{queue.length ? `答对 ${right}/${queue.length}。答错的词很快会再出现,答对的会隔更久。` : "现在没有要复习的词,学新课吧。"}</Text>
          <Button title="回首页" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.sub}>{i + 1}/{queue.length}</Text>
      <ExerciseView ex={ex} pack={pack} item={item} onDone={(r) => {
        const now = new Date();
        update((p) => {
          const next = recordAnswer(p, toAnswer(ex, r), now);
          return i + 1 >= queue.length ? finishReview(next, now) : next;
        });
        if (r.verdict !== "wrong") setRight(right + 1);
        setI(i + 1);
      }} />
    </ScrollView>
  );
}
