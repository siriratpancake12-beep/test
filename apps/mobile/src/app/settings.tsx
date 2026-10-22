import Constants from "expo-constants";
import { router } from "expo-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppState, Linking, Platform, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { GOAL_KINDS, productById, type Subscription } from "@lingo/core";
import { track } from "../analytics";
import { serverEnabled } from "../api";
import { accountLabel, errorText } from "../auth";
import { Button } from "../components/Button";
import { NeedConsent } from "../components/NeedConsent";
import { getPack } from "../content";
import { zhDate } from "../labels";
import { askNotifications, canAskNotifications, notificationsGranted, reschedule } from "../notify";
import { manageSubscriptionsUrl, PurchaseFailure, restore } from "../purchases";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * 设置:学习目标、每日提醒、会员、账号、隐私与协议、关于。
 * 注销账号必须在 App 里找得到(苹果审核和《个人信息保护法》都要求),放在"账号"里,不藏。
 * 没配置服务器时没有账号,整个"账号"部分不显示。
 * 基本功能模式(没同意隐私政策)下,登录、提醒、开通会员这些显示"同意隐私政策后可用",可以从"隐私"里查看并同意。
 */
type Perm = "granted" | "ask" | "denied" | "web";
type Confirm = "logout" | "delete" | "withdraw" | null;

/** App 备案号:备案下来后填进 app.json 的 extra.icpRecord;没填时显示占位(和协议里的占位符一样,上线前替换) */
const ICP = ((Constants.expoConfig?.extra ?? {}) as { icpRecord?: string }).icpRecord || "【App 备案号】";

export default function Settings() {
  const {
    lang, progress, sub, premium, applySub, reminders, setReminders,
    user, loginExpired, syncedAt, signOut, deleteAccount, consent, consented, basic, withdrawConsent, stats, setStats,
  } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  // 还没查到权限状态时什么都不显示,免得"允许通知"按钮闪一下
  const [perm, setPerm] = useState<Perm | null>(Platform.OS === "web" ? "web" : null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  const refreshPerm = useCallback(async () => {
    if (Platform.OS === "web") return;
    if (await notificationsGranted()) return setPerm("granted");
    setPerm((await canAskNotifications()) ? "ask" : "denied");
  }, []);
  // 从系统设置回来时权限可能变了
  useEffect(() => {
    void refreshPerm();
    const listener = AppState.addEventListener("change", (st) => {
      if (st === "active") void refreshPerm();
    });
    return () => listener.remove();
  }, [refreshPerm]);

  const rescheduleNow = () => {
    if (progress && pack) reschedule(progress, sub, `学${pack.nameZh}`).catch((e) => console.warn("排提醒失败", e));
  };
  const askPermission = async () => {
    const granted = await askNotifications();
    track("notification_prompt", { granted });
    await refreshPerm();
    rescheduleNow();
  };
  const toggleReminders = async (on: boolean) => {
    // 关掉时 store 已经取消了全部提醒;这里重新排一遍,把扣费前的提醒排回来
    await setReminders(on);
    if (on && perm === "ask") await askPermission();
    else rescheduleNow();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConfirm(null);
    } catch (e) {
      // 购买相关的失败 purchases.ts 已经弹窗说明了
      if (!(e instanceof PurchaseFailure)) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const doRestore = () => run(async () => {
    const events = await restore();
    track("restore", { found: events.length > 0 });
    if (events.length) applySub(events);
    setRestoreMsg(events.length ? "已恢复购买" : "没有找到可以恢复的购买记录");
  });

  // 开通会员要先登录(App Store 的交易要关联账号,换手机才能恢复);没配服务器时直接去会员页
  const openPaywall = () =>
    router.push(serverEnabled() && !user ? `/login?next=${encodeURIComponent("/paywall?reason=plan")}` : "/paywall?reason=plan");

  const goal = progress?.goal;
  const autoRenewOn = !!sub?.autoRenew && (sub.status === "trial" || sub.status === "active");
  const version = Constants.expoConfig?.version ?? "";

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Section title="学习目标">
        {goal && pack && (
          <Text style={s.body}>
            {pack.nameZh} · {GOAL_KINDS.find((g) => g.kind === goal.kind)?.zh ?? ""}{goal.exam ? ` · ${goal.exam}` : ""} · 目标 {goal.target} · 每天 {goal.dailyMinutes} 分钟
            {goal.deadline ? ` · ${zhDate(goal.deadline)}前` : ""}
          </Text>
        )}
        <Row title="调整学习目标" onPress={() => router.push("/onboarding")} />
      </Section>

      <Section title="每日提醒">
        {basic ? (
          <NeedConsent feature="学习提醒(要用通知权限)" compact />
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.body}>学习提醒</Text>
                <Text style={s.sub}>在你平时学习的时间提醒你;会员扣费前的提醒不受这个开关影响</Text>
              </View>
              <Switch
                testID="reminders-switch"
                value={reminders}
                onValueChange={(v) => void toggleReminders(v)}
                trackColor={{ true: color.primary, false: color.line }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={color.line}
              />
            </View>
            {reminders && perm === "ask" && <Button ghost title="允许通知" onPress={() => void askPermission()} />}
            {reminders && perm === "denied" && (
              <>
                <Text style={[s.sub, { color: color.warn }]}>通知权限已关闭,收不到提醒。可以在系统设置里打开。</Text>
                <Button ghost title="去系统设置" onPress={() => void Linking.openSettings()} />
              </>
            )}
            {perm === "web" && <Text style={s.sub}>网页版收不到提醒,请在手机 App 里设置。</Text>}
          </>
        )}
      </Section>

      <Section title="会员">
        <Text style={s.body}>{memberText(sub, premium)}</Text>
        {basic ? (
          <NeedConsent feature="开通会员、恢复购买" compact />
        ) : (
          <>
            {!premium && <Row testID="settings-paywall" title="开通会员" value={serverEnabled() && !user ? "需要先登录" : undefined} onPress={openPaywall} />}
            {!!sub && sub.status !== "expired" && sub.status !== "revoked" && (
              <Row title={autoRenewOn ? "管理订阅(取消自动续费)" : "管理订阅"} onPress={() => void Linking.openURL(manageSubscriptionsUrl)} />
            )}
            <Row testID="settings-restore" title="恢复购买" onPress={() => void doRestore()} />
            {!!restoreMsg && <Text style={s.sub}>{restoreMsg}</Text>}
            {!confirm && !!error && <Text style={[s.body, { color: color.bad }]}>{error}</Text>}
          </>
        )}
      </Section>

      {serverEnabled() && (
        <Section title="账号">
          {basic ? (
            <NeedConsent feature="登录、同步学习进度" compact />
          ) : user ? (
            <>
              <Text style={s.body}>{accountLabel(user)}</Text>
              <Text style={s.sub}>{syncedAt ? `学习进度已同步(${hm(syncedAt)})` : "学习进度会在联网时自动同步"}</Text>
              {confirm === "logout" ? (
                <ConfirmBox
                  text="退出后,这台手机上的学习记录会保留,可以继续学;再登录这个账号就会接着同步。会员跟着账号走,退出后这台手机上不再显示会员。"
                  action="退出登录" busy={busy}
                  onConfirm={() => run(signOut)} onCancel={() => setConfirm(null)}
                />
              ) : (
                <Row testID="settings-logout" title="退出登录" onPress={() => setConfirm("logout")} />
              )}
              {confirm === "delete" ? (
                <ConfirmBox
                  danger
                  text={
                    "注销后,账号和保存在云端的学习进度会被永久删除,无法恢复;这台手机上的学习记录也会清空,App 回到第一次打开的样子。"
                    + "\n\n注销账号不会取消自动续费的订阅。"
                    + (autoRenewOn ? "你现在开着自动续费,不想再被扣费请先到系统设置里取消。" : "通过 App Store 开通过会员的,请到系统的订阅管理里确认已经取消。")
                  }
                  action="确认注销" busy={busy}
                  onConfirm={() => run(deleteAccount)} onCancel={() => setConfirm(null)}
                />
              ) : (
                <Row testID="settings-delete" title="注销账号" danger onPress={() => setConfirm("delete")} />
              )}
            </>
          ) : (
            <>
              {loginExpired && <Text style={[s.sub, { color: color.warn }]}>登录已过期,请重新登录</Text>}
              <Text style={s.sub}>登录后换手机不丢进度、多台设备同步,开通会员也需要登录。不登录也能正常学习。</Text>
              <Button testID="settings-login" title="登录 / 注册" onPress={() => router.push("/login")} />
            </>
          )}
          {(confirm === "logout" || confirm === "delete") && !!error && <Text style={[s.body, { color: color.bad }]}>{error}</Text>}
        </Section>
      )}

      <Section title="隐私">
        {basic ? (
          <>
            <Text style={s.body}>基本功能模式:你没有同意《隐私政策》,我们不收集任何信息。</Text>
            <Text style={s.sub}>登录、同步、AI 对话、发音评测、学习提醒、开通会员暂时不能用,同意后就可以用。</Text>
            <Button testID="settings-consent" title="查看并同意隐私政策" onPress={() => router.push("/consent")} />
          </>
        ) : (
          <>
            {consented && !!consent && <Text style={s.sub}>你在 {zhDate(localDay(consent.at))}同意了现在这一版协议</Text>}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.body}>使用统计</Text>
                <Text style={s.sub}>记录用了哪些功能(不含你输入的内容),帮我们改进课程。关掉不影响学习</Text>
              </View>
              <Switch
                testID="stats-switch"
                value={stats}
                onValueChange={(v) => void setStats(v)}
                trackColor={{ true: color.primary, false: color.line }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={color.line}
              />
            </View>
            {confirm === "withdraw" ? (
              <ConfirmBox
                text="撤回后改用基本功能:停止收集你的信息,本机退出登录、取消学习提醒;登录、同步、AI 对话、发音评测、开通会员暂时不能用。本机的学习记录保留,随时可以重新同意。"
                action="撤回同意" busy={busy}
                onConfirm={() => run(withdrawConsent)} onCancel={() => setConfirm(null)}
              />
            ) : (
              <Row testID="settings-withdraw" title="撤回隐私政策同意" onPress={() => setConfirm("withdraw")} />
            )}
            {confirm === "withdraw" && !!error && <Text style={[s.body, { color: color.bad }]}>{error}</Text>}
          </>
        )}
      </Section>

      <Section title="协议">
        <Row title="用户协议" onPress={() => router.push("/legal?doc=terms")} />
        <Row title="隐私政策" onPress={() => router.push("/legal?doc=privacy")} />
        <Row title="自动续费服务规则" onPress={() => router.push("/legal?doc=renewal")} />
        <Row title="第三方 SDK 清单" onPress={() => router.push("/legal?doc=sdk")} />
        <Row title="全部协议和说明" onPress={() => router.push("/legal")} />
      </Section>

      <Section title="关于">
        <Text style={s.body}>语途 版本 {version}</Text>
        <Text style={s.sub}>App 备案号:{ICP}</Text>
      </Section>
    </ScrollView>
  );
}

function memberText(sub: Subscription | null, premium: boolean): string {
  if (!sub) return "免费版:第一单元和全部复习免费";
  const p = productById(sub.productId);
  const name = p?.titleZh ?? "会员";
  const renew = (sub.renewProductId && productById(sub.renewProductId)) || p;
  const price = renew ? `¥${renew.priceCny}/${renew.period === "year" ? "年" : "月"}` : "";
  const end = zhDate(sub.periodEnd.slice(0, 10));
  switch (sub.status) {
    case "trial":
      if (!premium) return "免费试用已结束";
      return `${name}免费试用中,${end}到期;` + (sub.autoRenew ? `到期后按 ${price} 自动续费` : "已关闭自动续费,到期后不会扣费");
    case "active":
      if (!premium) return `${name}已到期`;
      return `${name},有效期至 ${end};` + (sub.autoRenew ? `到期自动续费${renew && renew !== p ? renew.titleZh : ""} ${price}` : "已关闭自动续费,到期后不会扣费");
    case "grace":
    case "billing-retry":
      return `续费扣款没有成功,请在系统设置里检查付款方式${premium ? "(这期间会员照常可用)" : ""}`;
    case "expired":
      return `${name}已于 ${end}到期`;
    case "revoked":
      return `${name}已退款`;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 同步时间显示成当地的"时:分" */
const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** ISO 时间 → 当地日期 YYYY-MM-DD */
const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.sub, { marginLeft: 4 }]}>{title}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

function Row({ title, value, onPress, danger, testID }: { title: string; value?: string; onPress: () => void; danger?: boolean; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={[s.body, { flex: 1 }, danger ? { color: color.bad } : null]}>{title}</Text>
      {!!value && <Text style={[s.sub, { flexShrink: 1, textAlign: "right" }]}>{value}</Text>}
      <Text style={s.sub}>›</Text>
    </Pressable>
  );
}

/** 页面里的二次确认(网页版没有系统弹窗,这样在哪儿都一样) */
function ConfirmBox({ text, action, danger, busy, onConfirm, onCancel }: {
  text: string; action: string; danger?: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <View style={[s.card, { borderColor: danger ? color.bad : color.warn, padding: 12 }]}>
      <Text style={s.body}>{text}</Text>
      <Pressable
        testID="confirm-action"
        accessibilityRole="button"
        disabled={busy}
        onPress={onConfirm}
        style={({ pressed }) => [s.btn, { backgroundColor: danger ? color.bad : color.primary, opacity: busy ? 0.4 : pressed ? 0.7 : 1 }]}
      >
        <Text style={s.btnText}>{busy ? "请稍候…" : action}</Text>
      </Pressable>
      <Button ghost title="取消" disabled={busy} onPress={onCancel} />
    </View>
  );
}
