import { useLocalSearchParams } from "expo-router";
import { ScrollView, Text } from "react-native";
import { s } from "../theme";

const DOCS: Record<string, string> = {
  terms: "用户协议",
  privacy: "隐私政策",
  renewal: "自动续费服务规则",
};

/** 协议页。正式文本上线前由负责人确认(涉及法律责任),这里先占位。 */
export default function Legal() {
  const { doc = "terms" } = useLocalSearchParams<{ doc?: string }>();
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{DOCS[doc] ?? "协议"}</Text>
      <Text style={s.body}>正式文本待定,上线前由负责人和法务确认后替换。</Text>
    </ScrollView>
  );
}
