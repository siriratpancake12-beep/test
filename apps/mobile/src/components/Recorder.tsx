import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from "react-native";
import {
  AudioQuality, IOSOutputFormat, getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync,
  useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState, type RecordingOptions, type RecordingStatus,
} from "expo-audio";
import type { SpeechScoreRes } from "@lingo/core";
import { track } from "../analytics";
import { say, stopSpeaking } from "../speech";
import { canScoreSpeech, scoreSpeech } from "../speechScore";
import { color, s } from "../theme";
import { Button } from "./Button";
import { ScoreView, SelfCheck, verdictOfScore, type RecorderProps, type SpeakResult } from "./SpeakFeedback";

/**
 * 跟读录音(手机版;网页版见 Recorder.web.tsx):听标准发音 → 录下自己的 → 回放、和标准发音对比。
 * - 第一次用麦克风前先用一句话说明用途,学习者点了才弹系统的权限框(直接弹,同意率低,也容易让人不安);
 * - 一次最长 15 秒,够读完一句话;
 * - 已登录、服务器开通了评测时上传打分,显示分数和逐词颜色;否则学习者自己判断"像 / 不太像"。
 * 不能录(拒绝了权限、设备出错)时同样可以自己判断,练习不会卡住。
 */
const MAX_SECONDS = 15;

/** iOS 录成 16kHz 单声道 16 位 WAV(发音评测服务要这个格式);安卓录 16kHz 单声道 AAC(m4a),服务器转换 */
const OPTIONS: RecordingOptions = {
  extension: Platform.OS === "ios" ? ".wav" : ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  // PCM 的码率 = 16000 × 16 位 × 1 声道;AAC 说话用 32kbps 足够
  bitRate: Platform.OS === "ios" ? 256000 : 32000,
  android: { extension: ".m4a", outputFormat: "mpeg4", audioEncoder: "aac", sampleRate: 16000 },
  ios: {
    extension: ".wav",
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    sampleRate: 16000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: "audio/webm", bitsPerSecond: 64000 },
};

type Phase = "idle" | "ask" | "denied" | "failed" | "recording" | "scoring" | "recorded";

export function Recorder({ text, locale, lang, gender, voiceKey, done, nextLabel = "完成", onResult }: RecorderProps) {
  // 录音结束的回调要用最新的状态;expo-audio 只在创建录音机时登记一次监听,所以经过 ref 转一下
  const onStatus = useRef<(st: RecordingStatus) => void>(() => {});
  const recorder = useAudioRecorder(OPTIONS, (st) => onStatus.current(st));
  const rec = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uri, setUri] = useState<string | null>(null);
  const [score, setScore] = useState<SpeechScoreRes | null>(null);
  const [note, setNote] = useState("");
  const player = useAudioPlayer(uri ? { uri } : null);
  const playing = useAudioPlayerStatus(player).playing;
  const active = useRef(false);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const standard = useCallback((onDone?: () => void) => say(text, locale, false, { gender, voiceKey, onDone }), [text, locale, gender, voiceKey]);
  const playMine = useCallback(() => {
    stopSpeaking();
    player.seekTo(0).catch(() => {}).finally(() => player.play());
  }, [player]);

  // 录完:切回播放模式(iOS 录音模式下声音小)、短于半秒当作没录到;能打分就上传
  const finish = async (url: string | null) => {
    if (!active.current) return;
    active.current = false;
    clearTimer();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    if (!mounted.current) return;
    if (!url || Date.now() - startedAt.current < 500) {
      setPhase("idle");
      setNote("好像没录到声音,再试一次");
      return;
    }
    setUri(url);
    setScore(null);
    setNote("");
    if (!canScoreSpeech()) return setPhase("recorded");
    setPhase("scoring");
    const out = await scoreSpeech(url, lang, text);
    if (!mounted.current) return;
    if (out.kind === "scored") {
      setScore(out.result);
      track("speech_attempt", { scored: true, score: Math.round(out.result.score) });
    } else if (out.message) {
      setNote(`${out.message}。自己听一听,判断一下吧`);
    }
    setPhase("recorded");
  };
  onStatus.current = (st) => {
    if (st.isFinished || st.hasError) void finish(st.url ?? recorder.uri);
  };

  const start = async () => {
    stopSpeaking();
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: MAX_SECONDS });
      active.current = true;
      startedAt.current = Date.now();
      setNote("");
      setPhase("recording");
      // 保险:到了时间还没自己停,就手动停
      timer.current = setTimeout(() => void stop(), (MAX_SECONDS + 1) * 1000);
    } catch (e) {
      console.warn("录音失败", e);
      setPhase("failed");
    }
  };

  const stop = async () => {
    clearTimer();
    try {
      await recorder.stop();
    } catch (e) {
      console.warn("停止录音失败", e);
    }
    await finish(recorder.uri);
  };

  const begin = async () => {
    try {
      const perm = await getRecordingPermissionsAsync();
      if (perm.granted) return start();
      setPhase(perm.canAskAgain ? "ask" : "denied");
    } catch {
      setPhase("failed");
    }
  };

  const allow = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (perm.granted) return start();
      setPhase("denied");
    } catch {
      setPhase("failed");
    }
  };

  const report = (r: SpeakResult) => {
    if (!r.scored) track("speech_attempt", { scored: false, score: null });
    onResult(r);
  };

  useEffect(() => () => {
    mounted.current = false;
    clearTimer();
    if (active.current) {
      try {
        void recorder.stop().catch(() => {});
      } catch {
        // 页面关掉时录音机可能已经释放了
      }
    }
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selfCheck = <SelfCheck onPick={(like) => report({ verdict: like ? "correct" : "wrong", scored: false, score: null })} />;
  const playback = uri && (
    <View style={row}>
      <Chip title={playing ? "⏸ 暂停" : "▶ 我的录音"} onPress={() => (playing ? player.pause() : playMine())} />
      <Chip title="🔊 标准发音" onPress={() => standard()} />
      <Chip title="🔁 对比" onPress={() => standard(playMine)} />
    </View>
  );

  // 出结果以后还能回放、看逐词颜色
  if (done) return score || uri ? <View style={{ gap: 10 }}>{score && <ScoreView res={score} locale={locale} />}{playback}</View> : null;

  return (
    <View style={[s.card, { gap: 10 }]}>
      {phase === "idle" && (
        <>
          <Button title={uri ? "🎙 重新录" : "🎙 录下我的跟读"} onPress={begin} />
          <Text style={s.sub}>听完标准发音后录下自己读的,最长 {MAX_SECONDS} 秒。</Text>
          {playback}
        </>
      )}

      {phase === "ask" && (
        <>
          <Text style={s.body}>🎙 需要用麦克风录下你的跟读,好和标准发音对比;录音只在本机回放或用于打分,不会公开。</Text>
          <Button title="允许使用麦克风" onPress={allow} />
          <Text style={[s.sub, { color: color.primary }]} onPress={() => setPhase("failed")}>先不录,大声读完自己判断</Text>
        </>
      )}

      {(phase === "denied" || phase === "failed") && (
        <>
          <Text style={s.sub}>
            {phase === "denied" ? "麦克风权限关着,现在录不了音。可以在系统设置里打开;这次先大声跟读,自己判断。" : "现在录不了音。大声跟读几遍,自己判断一下。"}
          </Text>
          {phase === "denied" && <Text style={[s.sub, { color: color.primary }]} onPress={() => Linking.openSettings().catch(() => {})}>去系统设置</Text>}
          {selfCheck}
        </>
      )}

      {phase === "recording" && (
        <>
          <Text style={[s.h2, { color: color.bad }]}>● 正在录音 {Math.min(MAX_SECONDS, Math.floor(rec.durationMillis / 1000))} / {MAX_SECONDS} 秒</Text>
          <Button title="■ 读完了,停止" onPress={() => void stop()} />
        </>
      )}

      {phase === "scoring" && (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <ActivityIndicator />
          <Text style={s.sub}>正在打分…</Text>
        </View>
      )}

      {phase === "recorded" && (
        <>
          {playback}
          {score ? (
            <>
              <ScoreView res={score} locale={locale} />
              <View style={row}>
                <Chip title="🎙 再读一次" onPress={begin} />
                <View style={{ flexGrow: 1 }}>
                  <Button title={nextLabel} onPress={() => report({ verdict: verdictOfScore(score.score), scored: true, score: Math.round(score.score) })} />
                </View>
              </View>
            </>
          ) : (
            <>
              <Text style={s.sub}>先听"🔁 对比":标准发音和你的录音连着放。</Text>
              {selfCheck}
              <Text style={[s.sub, { color: color.primary }]} onPress={begin}>🎙 再录一次</Text>
            </>
          )}
        </>
      )}

      {!!note && <Text style={[s.sub, { color: color.warn }]}>{note}</Text>}
    </View>
  );
}

function Chip({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [chip, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={s.body}>{title}</Text>
    </Pressable>
  );
}

const row = { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" } as const;
const chip = { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: color.line, backgroundColor: color.card } as const;
