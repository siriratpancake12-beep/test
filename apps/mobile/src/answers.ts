import type { Answer, Exercise } from "@lingo/core";
import type { ExerciseResult } from "./components/ExerciseView";

/** 一道题的作答 → 进度里的一条记录 */
export function toAnswer(ex: Exercise, r: ExerciseResult): Answer {
  const target = "itemId" in ex ? { itemId: ex.itemId, direction: ex.direction } : { skill: ex.type === "speak" ? ("speak" as const) : ("write" as const) };
  return { ...target, verdict: r.verdict, ms: r.ms, issues: r.issues };
}
