import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StoreProvider } from "../store";

export default function RootLayout() {
  return (
    <StoreProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerBackTitle: "返回" }}>
        <Stack.Screen name="index" options={{ title: "学外语" }} />
        <Stack.Screen name="onboarding" options={{ title: "设定目标" }} />
        <Stack.Screen name="placement" options={{ title: "分级测试" }} />
        <Stack.Screen name="plan" options={{ title: "我的学习计划" }} />
        <Stack.Screen name="paywall" options={{ title: "会员", presentation: "modal" }} />
        <Stack.Screen name="lesson/[id]" options={{ title: "课程" }} />
        <Stack.Screen name="review" options={{ title: "今日复习" }} />
        <Stack.Screen name="drill" options={{ title: "弱点专练" }} />
        <Stack.Screen name="report" options={{ title: "本周学习报告" }} />
        <Stack.Screen name="legal" options={{ title: "协议" }} />
      </Stack>
    </StoreProvider>
  );
}
