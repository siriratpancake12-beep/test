import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { PRODUCTS, addDays, dayKey, monthlyPrice, projection, topWeakness, type Product } from "@lingo/core";
import { track } from "../analytics";
import { Button } from "../components/Button";
import { getLessons, getPack } from "../content";
import { issueLabel, zhDate, zhMonth } from "../labels";
import { DEV_PURCHASES, buy, manageSubscriptionsUrl, restore, startTrial } from "../purchases";
import { useStore } from "../store";
import { color, s } from "../theme";

const TITLE: Record<string, string> = {
  plan: "解锁你的完整学习计划",
  lesson: "继续学下去",
  unit: "第一单元学完了!",
  drill: "针对你的弱点专项训练",
  report: "看清自己的进步",
};

/**
 * 会员介绍。写给认真想学的人看:只列已经做好的功能,用他自己的数据说明会员能帮什么;
 * 价格、试用、自动续费、怎么取消,全部写在按钮旁边,不藏在小字里。
 */
export default function Paywall() {
  const { reason = "plan" } = useLocalSearchParams<{ reason?: string }>();
  const { lang, progress, sub, premium, applySub, markPaywall } = useStore();
  const [picked, setPicked] = useState<Product>(PRODUCTS[0]!);
  const [busy, setBusy] = useState(false);
  useEffect(() => markPaywall(), [markPaywall]);
  useEffect(() => track("paywall_view", { reason }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const pack = lang ? getPack(lang) : undefined;
  const now = new Date();
  const weak = progress ? topWeakness(progress, now) : undefined;
  const pr = progress && pack ? projection(progress, pack, getLessons(pack.code), now) : null;
  // 终点太远时先说"下一站",更真实也更有动力
  const next = pr?.milestones[0];
  const canTrial = picked.trialDays > 0 && !sub?.trialUsed;
  const chargeDay = addDays(dayKey(now, progress?.tz), picked.trialDays);

  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const run = async (fn: () => Promise<unknown[]>) => {
    setBusy(true);
    try {
      const events = await fn();
      if (!events.length) Alert.alert("没有找到可以恢复的购买记录");
      else {
        applySub(events as Parameters<typeof applySub>[0]);
        router.dismissTo("/");
      }
    } finally {
      setBusy(false);
    }
  };

  if (premium) {
    return (
      <View style={[s.screen, s.pad]}>
        <Text style={s.h1}>你已经是会员了</Text>
        <Button ghost title="管理订阅(取消自动续费)" onPress={() => Linking.openURL(manageSubscriptionsUrl)} />
        <Button title="返回" onPress={close} />
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {DEV_PURCHASES && <Text style={[s.sub, { color: color.warn }]}>开发模式:不会真实扣费</Text>}
      <Text style={s.h1}>{TITLE[reason] ?? TITLE.plan}</Text>

      <View style={s.card}>
        {next && <Text style={s.body}>🎯 按你的计划,预计 {zhMonth(next.etaDay)}达到 {next.level}{next.level !== pr?.target ? `,一步步走向 ${pr?.target}` : ""}</Text>}
        {weak && <Text style={s.body}>🔁 你最近在「{issueLabel(weak.kind)}」上反复出错:会员每天有针对性的专项训练</Text>}
        <Text style={s.body}>📚 解锁全部课程,新课持续更新</Text>
        <Text style={s.body}>📈 完整周报:听说读写各项能力、错误改善情况</Text>
        <Text style={s.body}>♻️ 复习永远免费,不开会员也能复习学过的内容</Text>
      </View>

      {PRODUCTS.map((p) => (
        <Pressable key={p.id} onPress={() => setPicked(p)}
          style={[s.card, picked.id === p.id ? { borderColor: color.primary, borderWidth: 2 } : null]}>
          <Text style={s.h2}>{p.titleZh} ¥{p.priceCny}/{p.period === "year" ? "年" : "月"}</Text>
          <Text style={s.sub}>
            {p.period === "year" ? `约 ¥${monthlyPrice(p)}/月` : "按月付,随时取消"}
            {p.trialDays && !sub?.trialUsed ? ` · 前 ${p.trialDays} 天免费` : ""}
          </Text>
        </Pressable>
      ))}

      <Button
        disabled={busy}
        title={canTrial ? `免费试用 ${picked.trialDays} 天` : `开通${picked.titleZh}`}
        onPress={() => run(async () => {
          const events = await (canTrial ? startTrial(picked.id) : buy(picked.id));
          if (events.length) track(canTrial ? "trial_start" : "purchase", { productId: picked.id });
          return events;
        })}
      />
      <Text style={s.sub}>
        {canTrial
          ? `试用期内取消不收费。${zhDate(chargeDay)}起按 ¥${picked.priceCny}/${picked.period === "year" ? "年" : "月"} 自动续费,扣费前 5 天和前 1 天都会提醒你。`
          : `开通后按 ¥${picked.priceCny}/${picked.period === "year" ? "年" : "月"} 自动续费,每次扣费前 5 天和前 1 天都会提醒你。`}
        随时可以在系统设置里取消。
      </Text>
      <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
        <Text style={[s.sub, { color: color.primary }]} onPress={() => run(async () => {
          const events = await restore();
          track("restore", { found: events.length > 0 });
          return events;
        })}>恢复购买</Text>
        <Text style={[s.sub, { color: color.primary }]} onPress={() => router.push("/legal?doc=terms")}>用户协议</Text>
        <Text style={[s.sub, { color: color.primary }]} onPress={() => router.push("/legal?doc=privacy")}>隐私政策</Text>
        <Text style={[s.sub, { color: color.primary }]} onPress={() => router.push("/legal?doc=renewal")}>自动续费规则</Text>
      </View>
      <Button ghost title="暂时不用" onPress={close} />
    </ScrollView>
  );
}
