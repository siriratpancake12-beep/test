import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "../components/Button";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * 第一次打开(或协议改版后)的隐私同意页。点"同意"之前:不记埋点、不申请任何权限、不联网。
 * 不同意:说明原因,可以回去再看;不强制退出、不反复弹窗。
 * 下面的要点只写 App 现在真实的做法;完整内容以协议正文(/legal)为准。
 */
const POINTS = [
  "学习进度、复习安排和学习目标保存在你的手机上。不登录也能完整使用。",
  "登录(手机号或 Apple 账号)后,学习进度会同步到语途的服务器,用来换手机时恢复、多台设备同步和开通会员。手机号只用于登录。",
  "为了改进课程,我们会统计功能的使用情况(比如学完了哪节课、用了多久),用一个随机生成的编号区分安装,不包含你输入的内容,也不读取设备标识、通讯录和位置。",
  "通知(学习提醒)和麦克风(跟读练习)权限,只在你用到相关功能时才会询问,随时可以在系统设置里关闭。",
  "你可以随时在「设置」里撤回同意、注销账号。语途面向 14 周岁及以上的用户。",
];

export default function Consent() {
  const { consent, agree } = useStore();
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  // 同意过旧版本:说明是协议更新了,不是第一次
  const updated = !!consent;
  const link = [s.body, { color: color.primary, paddingVertical: 4 }];

  if (declined) {
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.pad}>
        <View style={s.card}>
          <Text style={s.h2}>需要你同意后才能使用</Text>
          <Text style={s.body}>
            语途要在你的手机上保存学习进度、安排复习,这些都要按《隐私政策》处理你的信息,所以需要你先同意。
          </Text>
          <Text style={s.body}>你不同意的话,我们不会收集任何信息,也不会申请任何权限。可以再看看协议内容后决定;不想用的话直接关掉 App 就好。</Text>
        </View>
        <Button testID="consent-review" title="再看看" onPress={() => setDeclined(false)} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{updated ? "协议更新了" : "欢迎使用语途"}</Text>
      <Text style={s.body}>
        {updated
          ? "我们更新了《用户协议》和《隐私政策》,请看一下,同意后继续使用。"
          : "开始之前,请阅读《用户协议》和《隐私政策》。要点如下:"}
      </Text>
      <View style={s.card}>
        {POINTS.map((p, i) => (
          <Text key={i} style={s.body}>{i + 1}. {p}</Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16 }}>
        <Text accessibilityRole="link" style={link} onPress={() => router.push("/legal?doc=terms")}>《用户协议》</Text>
        <Text accessibilityRole="link" style={link} onPress={() => router.push("/legal?doc=privacy")}>《隐私政策》</Text>
      </View>
      <Button
        testID="consent-agree"
        disabled={busy}
        title="同意并继续"
        onPress={async () => {
          setBusy(true);
          try {
            await agree();
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button testID="consent-decline" ghost title="不同意" onPress={() => setDeclined(true)} />
    </ScrollView>
  );
}
