import * as AppleAuthentication from "expo-apple-authentication";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { AuthResult } from "@lingo/core";
import { serverEnabled } from "../api";
import {
  appleAvailable, appleSignIn, codeValid, errorText, phoneError, sendSmsCode, SMS_RESEND_SECONDS, verifySmsCode,
  type LoginMethod,
} from "../auth";
import { Button } from "../components/Button";
import { useStore } from "../store";
import { color, s } from "../theme";

/** 只留数字;系统自动填充或粘贴的"+86 138 0013 8000"去掉国家码 */
function normalizePhone(t: string): string {
  const d = t.replace(/\D/g, "");
  return (d.length > 11 && d.startsWith("86") ? d.slice(2) : d).slice(0, 11);
}

/**
 * 登录 / 注册(同一个流程:没注册过的手机号验证后自动注册)。
 * 只在配置了服务器时能进来。不登录也能学;登录是为了换手机不丢进度、多设备同步、购买会员。
 * 登录后回到来的地方(next 参数,比如登录后继续开通会员)。
 */
export default function Login() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const { ownerConflict, signIn } = useStore();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // 倒计时按结束时间算:App 切到后台再回来也准
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [apple, setApple] = useState(false);
  /** 换了账号:本机的学习记录属于另一个账号,等用户确认 */
  const [conflict, setConflict] = useState<{ r: AuthResult; method: LoginMethod } | null>(null);

  useEffect(() => {
    appleAvailable().then(setApple).catch(() => setApple(false));
  }, []);
  const left = Math.max(0, Math.ceil((resendAt - now) / 1000));
  useEffect(() => {
    if (!left) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [left > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!serverEnabled()) return <Redirect href="/" />;

  const leave = () => {
    // 只回到 App 内的页面
    if (next?.startsWith("/") && !next.startsWith("//")) router.replace(next);
    else if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (r: AuthResult, method: LoginMethod, replaceLocal = false) => {
    if (!replaceLocal && (await ownerConflict(r.user.id))) return setConflict({ r, method });
    setConflict(null);
    await signIn(r, method, replaceLocal);
    leave();
  };

  const send = () => run(async () => {
    const err = phoneError(phone);
    if (err) return setError(err);
    await sendSmsCode(phone);
    setSentTo(phone);
    setResendAt(Date.now() + SMS_RESEND_SECONDS * 1000);
    setNow(Date.now());
  });

  const verify = () => run(async () => {
    const err = phoneError(phone);
    if (err) return setError(err);
    if (!codeValid(code)) return setError("请输入 6 位验证码");
    await finish(await verifySmsCode(phone, code), "sms");
  });

  const loginWithApple = () => run(async () => {
    const r = await appleSignIn();
    if (r) await finish(r, "apple");
  });

  if (conflict) {
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.pad}>
        <View style={[s.card, { borderColor: color.warn }]}>
          <Text style={s.h2}>这台设备上有另一个账号的学习记录</Text>
          <Text style={s.body}>
            继续登录会清空本机的学习记录,改用这个账号保存在云端的进度。另一个账号已经同步过的进度还在云端,以后登录那个账号就能恢复。
          </Text>
        </View>
        <Button testID="login-switch" disabled={busy} title="继续登录" onPress={() => run(() => finish(conflict.r, conflict.method, true))} />
        <Button ghost title="取消" onPress={() => setConflict(null)} />
        {!!error && <Text style={[s.body, { color: color.bad }]}>{error}</Text>}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>登录语途</Text>
      <Text style={s.sub}>登录后换手机不丢进度、多台设备同步,还可以开通会员。不登录也能正常学习。</Text>

      <TextInput
        testID="phone-input"
        style={s.input}
        value={phone}
        onChangeText={(t) => { setPhone(normalizePhone(t)); setError(null); }}
        placeholder="手机号"
        placeholderTextColor={color.sub}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="telephoneNumber"
        autoComplete="tel"
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          testID="code-input"
          style={[s.input, { flex: 1, minWidth: 0 }]}
          value={code}
          onChangeText={(t) => { setCode(t.replace(/\D/g, "").slice(0, 6)); setError(null); }}
          placeholder="6 位验证码"
          placeholderTextColor={color.sub}
          keyboardType="number-pad"
          inputMode="numeric"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={6}
        />
        <View style={{ width: 128 }}>
          <Button
            testID="send-code"
            ghost
            disabled={busy || left > 0}
            title={left > 0 ? `${left} 秒后重发` : sentTo ? "重新获取" : "获取验证码"}
            onPress={send}
          />
        </View>
      </View>
      {!!sentTo && left > 0 && <Text style={s.sub}>验证码已发送到 {sentTo.slice(0, 3)} {sentTo.slice(3, 7)} {sentTo.slice(7)}</Text>}
      {!!error && <Text style={[s.body, { color: color.bad }]}>{error}</Text>}
      <Button testID="login-submit" disabled={busy} title="登录" onPress={verify} />

      {apple && (
        <>
          <Text style={[s.sub, { textAlign: "center", marginTop: 8 }]}>或者</Text>
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={12}
            style={{ height: 48, width: "100%" }}
            onPress={() => { if (!busy) void loginWithApple(); }}
          />
        </>
      )}

      <Text style={[s.sub, { marginTop: 8 }]}>
        手机号只用于登录和找回账号。没注册过的手机号验证后自动注册。详见
        <Text style={{ color: color.primary }} onPress={() => router.push("/legal?doc=privacy")}>《隐私政策》</Text>
        。
      </Text>
    </ScrollView>
  );
}
