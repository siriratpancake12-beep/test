import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { PRODUCTS, addDays, dayKey, monthlyPrice, projection, topWeakness, type Product, type SubEvent } from "@lingo/core";
import { track } from "../analytics";
import { Button } from "../components/Button";
import { NeedConsent } from "../components/NeedConsent";
import { getLessons, getPack } from "../content";
import { issueLabel, zhDate, zhMonth } from "../labels";
import { DEV_PURCHASES, PurchaseFailure, buy, manageSubscriptionsUrl, restore, startTrial, storeOffers, type StoreOffer } from "../purchases";
import { useStore } from "../store";
import { color, s } from "../theme";

const TITLE: Record<string, string> = {
  plan: "解锁你的完整学习计划",
  lesson: "继续学下去",
  unit: "第一单元学完了!",
  drill: "针对你的弱点专项训练",
  report: "看清自己的进步",
  tutor: "和 AI 老师多练几轮",
};

/**
 * 会员介绍。写给认真想学的人看:只列已经做好的功能,用他自己的数据说明会员能帮什么;
 * 价格、试用、自动续费、怎么取消,全部写在按钮旁边,不藏在小字里。
 * - 接了真实内购(DEV_PURCHASES 为 false)时,开通前要先登录:交易要关联账号,换手机才能恢复会员。
 * - App Store 能取到实际价格和试用资格时,按 App Store 的写(比如用的不是中国区的 Apple ID、已经试用过)。
 * - 购买、恢复出错时 purchases.ts 已经弹窗说明了,这里不再重复提示。
 * - 没同意隐私政策(基本功能模式)时可以看介绍,开通和恢复要先同意。
 */
export default function Paywall() {
  const { reason = "plan" } = useLocalSearchParams<{ reason?: string }>();
  const { lang, progress, sub, premium, applySub, markPaywall, consented, user } = useStore();
  const [picked, setPicked] = useState<Product>(PRODUCTS[0]!);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [offers, setOffers] = useState<Record<string, StoreOffer>>({});
  useEffect(() => markPaywall(), [markPaywall]);
  useEffect(() => track("paywall_view", { reason }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!consented) return;
    let alive = true;
    storeOffers()
      .then((o) => alive && setOffers(o))
      .catch((e: unknown) => console.warn("读取 App Store 价格失败", e));
    return () => {
      alive = false;
    };
  }, [consented]);

  const pack = lang ? getPack(lang) : undefined;
  const now = new Date();
  const weak = progress ? topWeakness(progress, now) : undefined;
  const pr = progress && pack ? projection(progress, pack, getLessons(pack.code), now) : null;
  // 终点太远时先说"下一站",更真实也更有动力
  const next = pr?.milestones[0];
  const offer = offers[picked.id];
  const unit = (p: Product) => (p.period === "year" ? "年" : "月");
  /** 显示的价格:App Store 有就用 App Store 的(它的货币、它的数字) */
  const priceOf = (p: Product) => offers[p.id]?.displayPrice ?? `¥${p.priceCny}`;
  // 试用资格:App Store 说用过了就是用过了(同一个 Apple ID 只能试用一次)
  const trialOk = (p: Product) => p.trialDays > 0 && !sub?.trialUsed && offers[p.id]?.trialEligible !== false;
  const canTrial = trialOk(picked);
  const chargeDay = addDays(dayKey(now, progress?.tz), picked.trialDays);
  // 真实内购要先登录;开发模式只在本机模拟,不用登录
  const needLogin = !DEV_PURCHASES && !user;
  const here = `/paywall?reason=${encodeURIComponent(reason)}`;

  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const login = () => router.push(`/login?next=${encodeURIComponent(here)}`);
  /** 开通或恢复。fn 返回会员事件;空数组 = 没有开通(恢复时 = 没找到记录) */
  const run = async (fn: () => Promise<SubEvent[]>, empty?: string) => {
    setBusy(true);
    setNote(null);
    try {
      const events = await fn();
      if (events.length) {
        applySub(events);
        router.dismissTo("/");
      } else if (empty) setNote(empty);
    } catch (e) {
      if (!(e instanceof PurchaseFailure)) {
        console.warn("开通会员出错", e);
        setNote("没有完成,请稍后再试");
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
        {reason === "tutor" && <Text style={s.body}>🗣 会员每天可以和 AI 老师多练很多轮(每天有上限),在点餐、问路这些场景里把学过的说出来</Text>}
        {next && <Text style={s.body}>🎯 按你的计划,预计 {zhMonth(next.etaDay)}达到 {next.level}{next.level !== pr?.target ? `,一步步走向 ${pr?.target}` : ""}</Text>}
        {weak && <Text style={s.body}>🔁 你最近在「{issueLabel(weak.kind)}」上反复出错:会员每天有针对性的专项训练</Text>}
        <Text style={s.body}>📚 解锁全部课程,新课持续更新</Text>
        <Text style={s.body}>📈 完整周报:听说读写各项能力、错误改善情况</Text>
        <Text style={s.body}>♻️ 复习永远免费,不开会员也能复习学过的内容</Text>
      </View>

      {PRODUCTS.map((p) => (
        <Pressable key={p.id} onPress={() => setPicked(p)}
          style={[s.card, picked.id === p.id ? { borderColor: color.primary, borderWidth: 2 } : null]}>
          <Text style={s.h2}>{p.titleZh} {priceOf(p)}/{unit(p)}</Text>
          <Text style={s.sub}>
            {p.period === "year" ? (offers[p.id] ? "一年付一次" : `约 ¥${monthlyPrice(p)}/月`) : "按月付,随时取消"}
            {trialOk(p) ? ` · 前 ${p.trialDays} 天免费` : ""}
          </Text>
        </Pressable>
      ))}
      {offer?.trialEligible === false && picked.trialDays > 0 && <Text style={s.sub}>你的 Apple ID 已经用过免费试用,这次开通会直接扣费。</Text>}

      {!consented ? (
        <NeedConsent feature="开通会员" />
      ) : needLogin ? (
        <>
          <Button testID="paywall-login" title={`登录后${canTrial ? `免费试用 ${picked.trialDays} 天` : `开通${picked.titleZh}`}`} onPress={login} />
          <Text style={s.sub}>开通会员需要登录:会员跟着账号走,换手机也能恢复。</Text>
        </>
      ) : (
        <Button
          disabled={busy}
          title={canTrial ? `免费试用 ${picked.trialDays} 天` : `开通${picked.titleZh}`}
          onPress={() => run(async () => {
            const events = await (canTrial ? startTrial(picked.id) : buy(picked.id));
            if (events.length) track(canTrial ? "trial_start" : "purchase", { productId: picked.id });
            return events;
          })}
        />
      )}
      <Text style={s.sub}>
        {canTrial
          ? `试用期内取消不收费。${zhDate(chargeDay)}起按 ${priceOf(picked)}/${unit(picked)} 自动续费,扣费前 5 天和前 1 天都会提醒你。`
          : `开通后按 ${priceOf(picked)}/${unit(picked)} 自动续费,每次扣费前 5 天和前 1 天都会提醒你。`}
        随时可以在系统设置里取消。
      </Text>
      {!!note && <Text style={[s.body, { color: color.warn }]}>{note}</Text>}
      <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
        {consented && (
          <Text style={[s.sub, { color: color.primary }]} onPress={() => (needLogin ? login() : void run(async () => {
            const events = await restore();
            track("restore", { found: events.length > 0 });
            return events;
          }, "没有找到可以恢复的购买记录"))}>恢复购买</Text>
        )}
        <Text style={[s.sub, { color: color.primary }]} onPress={() => router.push("/legal?doc=terms")}>用户协议</Text>
        <Text style={[s.sub, { color: color.primary }]} onPress={() => router.push("/legal?doc=privacy")}>隐私政策</Text>
        <Text style={[s.sub, { color: color.primary }]} onPress={() => router.push("/legal?doc=renewal")}>自动续费规则</Text>
      </View>
      <Button ghost title="暂时不用" onPress={close} />
    </ScrollView>
  );
}
