import { Redirect, router } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "../components/Button";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * 隐私同意页,三种情况:
 * - 第一次打开、协议改版后:先看摘要再决定。点"同意"之前不记埋点、不申请任何权限、不联网。
 *   不同意:说明原因,可以"先用基本功能"(离线学习、复习、看周报),也可以回去再看;不强制退出、不反复弹窗。
 * - 基本功能模式下从"同意隐私政策后可用"的地方点进来:看完同意就回到原来的页面。
 * - 已经同意了:直接回首页。
 * 下面的要点只写 App 现在真实的做法;完整内容以协议正文(/legal)为准。
 */
const POINTS = [
  "学习进度、复习安排和学习目标保存在你的手机上。不登录也能完整学习。",
  "登录(手机号或 Apple 账号)后,学习进度会同步到语途的服务器,用来换手机时恢复、多台设备同步和开通会员。手机号只用于登录。",
  "为了改进课程,我们会统计功能的使用情况(比如学完了哪节课、用了多久),用一个随机生成的编号区分安装,不包含你输入的内容,也不读取设备标识、通讯录和位置;可以在「设置」里关闭。",
  "AI 对话的文字、发音评分的录音会交给服务商处理,我们不保存对话内容,录音评分后立即删除。",
  "通知(学习提醒)和麦克风(跟读打分)权限,只在你用到相关功能时才会询问,随时可以在系统设置里关闭。",
  "你可以随时在「设置」里撤回同意、注销账号。语途面向 14 周岁及以上的用户。",
];

export default function Consent() {
  const { consented, basic, consent, agree, goBasic } = useStore();
  const [declined, setDeclined] = useState(false);
  // 做了决定、正在离开这一页:不再显示内容(状态先变、页面后走,中间不闪一下别的样子)
  const [leaving, setLeaving] = useState(false);

  if (leaving) return <View style={s.screen} />;
  // 已经同意过现在这一版:不用再看(从深链接之类进来的)
  if (consented) return router.canGoBack() ? <Done /> : <Redirect href="/" />;

  /** 基本功能模式下是从别的页面点进来的,做完决定回到那里;第一次打开去首页(新用户会转到引导) */
  const leave = (fromBasic: boolean) => (fromBasic && router.canGoBack() ? router.back() : router.replace("/"));
  const decide = async (fn: () => Promise<void>) => {
    const fromBasic = basic;
    setLeaving(true);
    try {
      await fn();
    } catch (e) {
      console.warn("保存隐私选择失败", e);
      return setLeaving(false);
    }
    leave(fromBasic);
  };
  const link = [s.body, { color: color.primary, paddingVertical: 4 }];

  if (declined) {
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.pad}>
        <View style={s.card}>
          <Text style={s.h2}>不同意也可以先用基本功能</Text>
          <Text style={s.body}>
            基本功能:离线学习、复习、看周报都能用;不记录使用统计、不联网、不申请通知和麦克风权限。
          </Text>
          <Text style={s.body}>
            登录、同步进度、AI 对话、发音评测、开通会员要处理你的个人信息,需要同意《隐私政策》后才能用。以后随时可以在「设置」里查看并同意。
          </Text>
        </View>
        <Button testID="consent-basic" title="先用基本功能" onPress={() => void decide(goBasic)} />
        <Button testID="consent-review" ghost title="再看看协议" onPress={() => setDeclined(false)} />
      </ScrollView>
    );
  }

  // 基本功能模式下点进来的,或者协议改版了
  const updated = !basic && !!consent;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{basic ? "同意后可以用全部功能" : updated ? "协议更新了" : "欢迎使用语途"}</Text>
      <Text style={s.body}>
        {basic
          ? "登录、同步、AI 对话、发音评测、开通会员需要按《隐私政策》处理你的个人信息。要点如下:"
          : updated
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
      <Button testID="consent-agree" title={basic ? "同意" : "同意并继续"} onPress={() => void decide(agree)} />
      {basic ? (
        <Button testID="consent-later" ghost title="暂不同意" onPress={() => leave(true)} />
      ) : (
        <Button testID="consent-decline" ghost title="不同意" onPress={() => setDeclined(true)} />
      )}
    </ScrollView>
  );
}

function Done() {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={s.card}>
        <Text style={s.body}>你已经同意了现在这一版《用户协议》和《隐私政策》,可以在「设置」里随时撤回。</Text>
        <Button title="返回" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}
