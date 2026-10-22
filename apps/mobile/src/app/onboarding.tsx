import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { GOAL_KINDS, addDays, dayKey, setGoal, type Cefr, type Goal, type GoalKind } from "@lingo/core";
import { Button } from "../components/Button";
import { Option } from "../components/Option";
import { availableLangs, comingSoonLangs } from "../content";
import { useStore } from "../store";
import { s } from "../theme";

/**
 * 新用户引导:选语种 → 为什么学 → 学到什么水平 → 每天多久 → 有没有期限 → 有没有基础。
 * 目的不是收集信息,而是让学习者自己做出承诺,并在下一屏看到一个具体、可信的计划。
 */
const LEVELS: { level: Cefr; zh: string }[] = [
  { level: "A1", zh: "能应付最简单的交流:打招呼、点餐、问路" },
  { level: "A2", zh: "能处理旅行、购物等日常事务,聊熟悉的话题" },
  { level: "B1", zh: "能在国外独立生活学习,应付大部分日常情况" },
  { level: "B2", zh: "能流利讨论较复杂的话题,很多留学、移民项目要求这个水平" },
];
const MINUTES = [
  { m: 10, zh: "轻松" },
  { m: 15, zh: "常规" },
  { m: 30, zh: "认真" },
  { m: 60, zh: "冲刺" },
  { m: 90, zh: "全力备考" },
];
const DEADLINES = [
  { days: 0, zh: "没有期限" },
  { days: 90, zh: "3 个月内" },
  { days: 180, zh: "6 个月内" },
  { days: 365, zh: "1 年内" },
];

type Step = "lang" | "kind" | "level" | "minutes" | "deadline" | "base";

export default function Onboarding() {
  const { lang, progress, setLang, update } = useStore();
  const [step, setStep] = useState<Step>(lang ? "kind" : "lang");
  const [draft, setDraft] = useState<Partial<Goal>>(progress?.goal ?? {});
  const [picked, setPicked] = useState<string | null>(null);

  // 换到一门以前学过、已经有目标的语言:直接回首页,不用重新设定。
  // 只在刚选完语言、新语言的进度读进来时检查一次;之后设定目标不能再触发这里。
  useEffect(() => {
    if (!picked || progress?.lang !== picked) return;
    setPicked(null);
    if (progress.goal) router.replace("/");
  }, [picked, progress]);

  const finish = (hasBase: boolean) => {
    const goal = draft as Goal;
    update((p) => setGoal(p, goal));
    router.replace(hasBase ? "/placement" : "/plan?first=1");
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {step === "lang" && (
        <>
          <Text style={s.h1}>你想学哪门语言?</Text>
          {availableLangs().map((p) => (
            <Option key={p.code} title={`${p.nameZh} · ${p.nativeName}`} sub={`考试方向:${p.examsZh.join("、")}`}
              onPress={async () => { await setLang(p.code); setPicked(p.code); setStep("kind"); }} />
          ))}
          <Text style={[s.sub, { marginTop: 8 }]}>即将上线:{comingSoonLangs().map((p) => p.nameZh).join("、")}</Text>
        </>
      )}

      {step === "kind" && (
        <>
          <Text style={s.h1}>你为什么想学?</Text>
          {GOAL_KINDS.map((g) => (
            <Option key={g.kind} title={g.zh} selected={draft.kind === g.kind}
              onPress={() => { setDraft({ ...draft, kind: g.kind as GoalKind }); setStep("level"); }} />
          ))}
        </>
      )}

      {step === "level" && (
        <>
          <Text style={s.h1}>想学到什么水平?</Text>
          {LEVELS.map((l) => (
            <Option key={l.level} title={l.level} sub={l.zh} selected={draft.target === l.level}
              onPress={() => { setDraft({ ...draft, target: l.level }); setStep("minutes"); }} />
          ))}
        </>
      )}

      {step === "minutes" && (
        <>
          <Text style={s.h1}>每天能学多久?</Text>
          <Text style={s.sub}>每天坚持比偶尔学很久有效得多。随时可以改。</Text>
          {MINUTES.map((m) => (
            <Option key={m.m} title={`${m.m} 分钟`} sub={m.zh} selected={draft.dailyMinutes === m.m}
              onPress={() => { setDraft({ ...draft, dailyMinutes: m.m }); setStep("deadline"); }} />
          ))}
        </>
      )}

      {step === "deadline" && (
        <>
          <Text style={s.h1}>有期限吗?</Text>
          <Text style={s.sub}>比如考试、出国的日子。我们会告诉你按现在的安排能不能来得及。</Text>
          {DEADLINES.map((d) => (
            <Option key={d.days} title={d.zh} onPress={() => {
              const { deadline: _, ...rest } = draft;
              setDraft(d.days ? { ...rest, deadline: addDays(dayKey(new Date(), progress?.tz), d.days) } : rest);
              setStep("base");
            }} />
          ))}
        </>
      )}

      {step === "base" && (
        <>
          <Text style={s.h1}>之前学过吗?</Text>
          <Option title="零基础" sub="从最基础的发音和打招呼开始" onPress={() => finish(false)} />
          <Option title="学过一些" sub="做个 3 分钟的分级测试,跳过已经会的内容" onPress={() => finish(true)} />
        </>
      )}

      {step !== "lang" && step !== "kind" && (
        <Button ghost title="上一步" onPress={() => setStep(({ level: "kind", minutes: "level", deadline: "minutes", base: "deadline" } as const)[step])} />
      )}
    </ScrollView>
  );
}
