import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { PurchaseSync } from "../purchases";
import { StoreProvider, useStore } from "../store";
import { color } from "../theme";

// 启动图留到读完本机记录:读完才知道先显示哪一页(同意页、新用户引导还是首页),中间不闪空白
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  return (
    <StoreProvider>
      <StatusBar style="dark" />
      <Screens />
    </StoreProvider>
  );
}

/**
 * 隐私:第一次打开(或协议改版后)还没做决定时,只能看同意页和协议页,其他页面都进不去(进去会被转到同意页),
 * 所以不会记录任何数据、申请任何权限。同意了,或者选了"先用基本功能",才能进 App。
 * 同意页一直能进:基本功能模式下要从"同意隐私政策后可用"的地方点进去同意。
 * 会员状态和服务器对齐(PurchaseSync)要联网,只在同意以后挂上。
 */
function Screens() {
  const { ready, consented, basic } = useStore();
  const decided = consented || basic;
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  return (
    <>
      {consented && <PurchaseSync />}
      <Stack screenOptions={{ headerBackTitle: "返回" }}>
        <Stack.Protected guard={decided} redirectTo="/consent">
          <Stack.Screen name="index" options={{ title: "语途" }} />
          <Stack.Screen name="onboarding" options={{ title: "设定目标" }} />
          <Stack.Screen name="placement" options={{ title: "分级测试" }} />
          <Stack.Screen name="plan" options={{ title: "我的学习计划" }} />
          <Stack.Screen name="paywall" options={{ title: "会员", presentation: "modal" }} />
          <Stack.Screen name="lesson/[id]" options={{ title: "课程" }} />
          <Stack.Screen name="review" options={{ title: "今日复习" }} />
          <Stack.Screen name="drill" options={{ title: "弱点专练" }} />
          <Stack.Screen name="report" options={{ title: "本周学习报告" }} />
          <Stack.Screen name="checkpoint" options={{ title: "单元测评" }} />
          <Stack.Screen name="certificate" options={{ title: "单元证书" }} />
          <Stack.Screen name="tutor" options={{ title: "AI 对话练习" }} />
          <Stack.Screen name="settings" options={{ title: "设置" }} />
          <Stack.Screen name="login" options={{ title: "登录 / 注册" }} />
        </Stack.Protected>
        <Stack.Screen name="consent" options={{ title: "用户协议与隐私政策", headerBackVisible: basic, gestureEnabled: basic }} />
        <Stack.Screen name="legal" options={{ title: "协议" }} />
      </Stack>
    </>
  );
}
