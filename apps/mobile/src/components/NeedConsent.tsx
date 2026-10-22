import { router } from "expo-router";
import { Text, View } from "react-native";
import { color, s } from "../theme";
import { Button } from "./Button";

/**
 * 基本功能模式(没同意隐私政策)下,要处理个人信息的功能(登录、同步、AI 对话、发音评测、开通会员)
 * 显示这张卡:说明原因,点了去重新查看并同意(/consent),同意后回到这里。
 * compact:放在别的内容中间时只显示一行字和链接。
 */
export function NeedConsent({ feature, compact }: { feature: string; compact?: boolean }) {
  const open = () => router.push("/consent");
  if (compact) {
    return (
      <Text style={s.sub}>
        {feature}:同意《隐私政策》后可用。
        <Text style={{ color: color.primary }} onPress={open}>查看并同意</Text>
      </Text>
    );
  }
  return (
    <View style={[s.card, { borderColor: color.warn }]}>
      <Text style={s.h2}>{feature}:同意隐私政策后可用</Text>
      <Text style={s.body}>
        你现在用的是基本功能:可以离线学习、复习、看周报,我们不收集任何信息。{feature}需要处理你的个人信息,同意《隐私政策》后才能用。
      </Text>
      <Button testID="need-consent" title="查看并同意" onPress={open} />
    </View>
  );
}
