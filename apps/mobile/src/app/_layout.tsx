import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { StoreProvider, useStore } from "../store";
import { color } from "../theme";

export default function RootLayout() {
  return (
    <StoreProvider>
      <StatusBar style="dark" />
      <Screens />
    </StoreProvider>
  );
}

/**
 * 隐私同意之前只能看同意页和协议页,其他页面都进不去(进去会被转到同意页),
 * 所以同意前不会记录任何数据、申请任何权限。同意(或协议改版后重新同意)之后同意页就进不去了。
 */
function Screens() {
  const { ready, consented } = useStore();
  // 读本机记录只要一瞬间;读完才知道该先显示哪一页,这之前只给一块背景色
  if (!ready) return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  return (
    <Stack screenOptions={{ headerBackTitle: "返回" }}>
      <Stack.Protected guard={consented} redirectTo="/consent">
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
      <Stack.Protected guard={!consented} redirectTo="/">
        <Stack.Screen name="consent" options={{ title: "用户协议与隐私政策", headerBackVisible: false, gestureEnabled: false }} />
      </Stack.Protected>
      <Stack.Screen name="legal" options={{ title: "协议" }} />
    </Stack>
  );
}
