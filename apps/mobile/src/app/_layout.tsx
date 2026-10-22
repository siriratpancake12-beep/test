import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StoreProvider } from "../store";

export default function RootLayout() {
  return (
    <StoreProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerBackTitle: "返回" }}>
        <Stack.Screen name="index" options={{ title: "学外语" }} />
        <Stack.Screen name="lesson/[id]" options={{ title: "课程" }} />
        <Stack.Screen name="review" options={{ title: "今日复习" }} />
      </Stack>
    </StoreProvider>
  );
}
