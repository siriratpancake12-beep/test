import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import {
  ROUTES, TutorChatRes, isDone, nextLesson, type Cefr, type LanguagePack, type Progress, type Scenario, type TutorChatRes as ChatRes,
} from "@lingo/core";
import { track } from "../analytics";
import { ApiFailure, api, getToken, serverEnabled } from "../api";
import { Button } from "../components/Button";
import { ChatBubble } from "../components/ChatBubble";
import { getLesson, getLessons, getPack, getScenarios, itemPool } from "../content";
import { say, stopSpeaking } from "../speech";
import { useStore } from "../store";
import { color, s } from "../theme";

/**
 * AI 口语对话:在具体场景里(点餐、问路……)用学习语言完成一件事,AI 扮演对方,尽量只用学习者学过的词,
 * 说错了用中文解释怎么改。场景来自 content/scenarios/<lang>.json;对话走服务器(ROUTES.tutorChat)。
 *
 * - AI 说的话和纠错都标"AI 生成"(《生成式人工智能服务管理暂行办法》《人工智能生成合成内容标识办法》要求显式标识);
 * - 没配置服务器:说明"需要联网使用";没登录:引导登录;免费次数用完:引导了解会员(会员也有每天的上限)。
 * 参数 id 是场景 id;不带 id 显示场景列表。
 */
const MAX_INPUT = 300;
/** 接口一次最多带 30 条对话 */
const MAX_MESSAGES = 30;
/** 学过的词最多带 400 个(接口上限) */
const MAX_KNOWN = 400;

type Correction = ChatRes["reply"]["corrections"][number];
interface Turn { role: "user" | "tutor"; text: string; zh?: string; corrections?: Correction[] }

export default function Tutor() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { lang, progress, premium } = useStore();
  const pack = lang ? getPack(lang) : undefined;
  // 登录凭证不是响应式的:从登录页回来时重新看一下
  const [loggedIn, setLoggedIn] = useState(() => !!getToken());
  useFocusEffect(useCallback(() => setLoggedIn(!!getToken()), []));

  if (!pack || !progress) return null;
  const scenarios = getScenarios(pack.code);
  if (!scenarios.length) {
    return <Notice title="即将开放" body={`${pack.nameZh}的 AI 对话场景正在准备中(点餐、问路、自我介绍……),很快就能和 AI 老师练口语了。`} />;
  }
  if (!serverEnabled()) {
    return <Notice title="需要联网使用" body="AI 对话练习要连接语途的服务器,由服务器上的 AI 老师和你对话。现在这个版本没有连接服务器,其他学习功能都可以离线使用。" />;
  }
  const scenario = id ? scenarios.find((x) => x.id === id) : undefined;
  if (!scenario) return <ScenarioList scenarios={scenarios} progress={progress} pack={pack} />;
  if (!loggedIn) {
    return (
      <Notice title="登录后就能开始对话" body="AI 对话要用服务器上的 AI 老师,需要先登录;登录后学习进度也会同步到你的其他设备。">
        <Button title="去登录" onPress={() => router.push("/login")} />
      </Notice>
    );
  }
  return <Chat key={scenario.id} scenario={scenario} pack={pack} progress={progress} premium={premium} />;
}

function Notice({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={s.card}>
        <Text style={s.h2}>{title}</Text>
        <Text style={s.body}>{body}</Text>
        {children}
      </View>
    </ScrollView>
  );
}

function ScenarioList({ scenarios, progress, pack }: { scenarios: Scenario[]; progress: Progress; pack: LanguagePack }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.body}>在真实的场景里用{pack.nameZh}完成一件事:AI 扮演对方,尽量只用你学过的词;说错了,用中文告诉你怎么改。</Text>
      <Text style={aiTag}>🤖 对话内容由 AI 生成</Text>
      {scenarios.map((sc) => {
        const locked = !!sc.unlockAfter && !isDone(progress, sc.unlockAfter);
        return (
          <Pressable key={sc.id} disabled={locked} onPress={() => router.push(`/tutor?id=${sc.id}`)} style={[s.card, { opacity: locked ? 0.5 : 1 }]}>
            <Text style={s.sub}>{sc.level} · 对方:{sc.roleZh}</Text>
            <Text style={s.h2}>{locked ? "🔒 " : ""}{sc.titleZh}</Text>
            <Text style={s.body}>{sc.goalZh}</Text>
            {locked && <Text style={s.sub}>学完「{getLesson(sc.unlockAfter!)?.titleZh ?? sc.unlockAfter}」后开放</Text>}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** 学习者现在的水平:正在学的那节课的等级(全学完了取最后一课的) */
function learnerLevel(p: Progress, code: string, fallback: Cefr): Cefr {
  const lessons = getLessons(code);
  return nextLesson(lessons, p)?.cefr ?? lessons.at(-1)?.cefr ?? fallback;
}

/** 学过的词的原文,最近学的在前(AI 老师多用刚学的词,正好帮着复习) */
function knownWords(p: Progress, code: string): string[] {
  const text = new Map(itemPool(code).map((i) => [i.id, i.text]));
  const ids = Object.entries(p.learned).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([itemId]) => itemId);
  return [...new Set(ids.map((x) => text.get(x)).filter((t): t is string => !!t))].slice(0, MAX_KNOWN);
}

/** 免费次数用完 / 需要会员:服务器返回的错误码里带 quota、limit 或 premium(和 server-ai 约定) */
const isQuota = (f: ApiFailure) => f.status === 402 || /quota|limit|premium/i.test(f.code);

function Chat({ scenario, pack, progress, premium }: { scenario: Scenario; pack: LanguagePack; progress: Progress; premium: boolean }) {
  const opening: Turn = { role: "tutor", text: scenario.opening.text, zh: scenario.opening.zh };
  const level = useMemo(() => learnerLevel(progress, pack.code, scenario.level), [progress, pack.code, scenario.level]);
  const words = useMemo(() => knownWords(progress, pack.code), [progress.learned, pack.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const [turns, setTurns] = useState<Turn[]>([opening]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<"login" | "quota" | null>(null);
  const [error, setError] = useState("");
  const [zh, setZh] = useState<Record<number, boolean>>({});
  const [hints, setHints] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  useFocusEffect(useCallback(() => () => stopSpeaking(), []));

  const send = async () => {
    const text = input.trim().slice(0, MAX_INPUT);
    if (!text || busy || blocked) return;
    const before = turns;
    const history: Turn[] = [...before, { role: "user", text }];
    setTurns(history);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const res = await api("POST", ROUTES.tutorChat, {
        lang: pack.code,
        scenarioId: scenario.id,
        level,
        knownWords: words,
        messages: history.filter((t) => t.text.trim()).slice(-MAX_MESSAGES).map((t) => ({ role: t.role, text: t.text.slice(0, 500) })),
      }, TutorChatRes, 30000);
      track("tutor_message", { scenarioId: scenario.id });
      // 纠错说的是学习者刚才那句,挂在那句下面
      setTurns([...before, { role: "user", text, corrections: res.reply.corrections }, { role: "tutor", text: res.reply.text, zh: res.reply.zh }]);
      setRemaining(res.remainingToday);
      if (res.reply.done) setDone(true);
      if (res.remainingToday <= 0) setBlocked("quota");
    } catch (e) {
      // 没发出去:撤回这句,放回输入框,可以再发
      setTurns(before);
      setInput(text);
      const f = e instanceof ApiFailure ? e : null;
      if (f?.status === 401) setBlocked("login");
      else if (f && isQuota(f)) setBlocked("quota");
      else setError(f?.message ?? "出错了,请稍后再试");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    stopSpeaking();
    setTurns([opening]);
    setDone(false);
    setError("");
    setZh({});
  };

  return (
    <ScrollView
      ref={scroll}
      style={s.screen}
      contentContainerStyle={s.pad}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
    >
      <Stack.Screen options={{ title: scenario.titleZh }} />
      <View style={s.card}>
        <Text style={s.sub}>你的任务 · 对方:{scenario.roleZh}</Text>
        <Text style={s.h2}>{scenario.goalZh}</Text>
        {scenario.tasks.map((t) => (
          <Text key={t} style={s.body}>{done ? "✅" : "▫️"} {t}</Text>
        ))}
      </View>
      <Text style={aiTag}>🤖 对方的回复和纠错由 AI 生成,可能有错,仅供练习参考</Text>

      {turns.map((t, i) => (t.role === "tutor" ? (
        <ChatBubble key={i} side="left" name={scenario.roleZh} tag="AI 生成" text={t.text} zh={zh[i] ? t.zh : undefined}>
          <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
            <Text style={link} onPress={() => say(t.text, pack.locale)}>🔊 听</Text>
            {!!t.zh && <Text style={link} onPress={() => setZh({ ...zh, [i]: !zh[i] })}>{zh[i] ? "收起中文" : "看中文"}</Text>}
          </View>
        </ChatBubble>
      ) : (
        <View key={i} style={{ gap: 6 }}>
          <ChatBubble side="right" name="我" text={t.text} />
          {t.corrections?.map((c, k) => <CorrectionCard key={k} c={c} />)}
        </View>
      )))}
      {busy && <Text style={s.sub}>{scenario.roleZh}正在回复…</Text>}

      {done && (
        <View style={[s.card, { borderColor: color.good }]}>
          <Text style={s.h2}>🎉 任务完成!</Text>
          <Text style={s.body}>你用{pack.nameZh}完成了:{scenario.goalZh}</Text>
          <View style={row}>
            <View style={grow}><Button ghost title="再练一次" onPress={restart} /></View>
            <View style={grow}><Button ghost title="换个场景" onPress={() => router.back()} /></View>
          </View>
        </View>
      )}

      {blocked === "login" && (
        <View style={[s.card, { borderColor: color.warn }]}>
          <Text style={s.body}>登录已过期,请重新登录后继续对话。</Text>
          <Button title="去登录" onPress={() => router.push("/login")} />
        </View>
      )}
      {blocked === "quota" && (
        <View style={[s.card, { borderColor: color.warn }]}>
          {premium ? (
            <Text style={s.body}>今天的对话次数用完了,明天再来吧。学过的内容可以先去复习。</Text>
          ) : (
            <>
              <Text style={s.body}>今天的免费对话次数用完了,明天会恢复。开通会员每天可以多练很多轮。</Text>
              <Button title="了解会员" onPress={() => router.push("/paywall?reason=tutor")} />
            </>
          )}
        </View>
      )}
      {!!error && <Text style={[s.sub, { color: color.bad }]}>{error}</Text>}

      {!blocked && (
        <View style={{ gap: 8 }}>
          {hints && scenario.usefulPhrases.map((p) => (
            <Pressable key={p.text} onPress={() => setInput(p.text)} style={hint}>
              <Text style={s.body}>{p.text}</Text>
              <Text style={s.sub}>{p.zh}</Text>
            </Pressable>
          ))}
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput
              style={[s.input, { flex: 1, fontSize: 16 }]}
              value={input}
              onChangeText={setInput}
              placeholder={`用${pack.nameZh}回答…`}
              maxLength={MAX_INPUT}
              editable={!busy}
              autoCorrect={false}
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={() => void send()}
              onFocus={() => setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 300)}
            />
            <Pressable accessibilityRole="button" disabled={!input.trim() || busy} onPress={() => void send()}
              style={[s.btn, { paddingHorizontal: 16, opacity: !input.trim() || busy ? 0.4 : 1 }]}>
              <Text style={s.btnText}>发送</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <Text style={link} onPress={() => setHints(!hints)}>💡 {hints ? "收起提示" : "提示句子"}</Text>
            {remaining !== null && <Text style={s.sub}>今日剩余 {remaining} 次</Text>}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function CorrectionCard({ c }: { c: Correction }) {
  return (
    <View style={[s.card, { borderColor: color.warn, alignSelf: "flex-end", maxWidth: "88%", gap: 4 }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <Text style={s.sub}>✏️ 这样说更好</Text>
        <Text style={aiTag}>AI 生成</Text>
      </View>
      <Text style={[s.body, { textDecorationLine: "line-through", color: color.sub }]}>{c.original}</Text>
      <Text style={[s.body, { color: color.good, fontWeight: "600" }]}>{c.corrected}</Text>
      <Text style={s.sub}>{c.explanationZh}</Text>
    </View>
  );
}

const aiTag = { fontSize: 12, color: color.sub } as const;
const link = { fontSize: 14, color: color.primary } as const;
const row = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
const grow = { flexGrow: 1, flexBasis: 120 } as const;
const hint = { borderWidth: 1, borderColor: color.line, borderRadius: 10, padding: 10, backgroundColor: color.card, gap: 2 } as const;
