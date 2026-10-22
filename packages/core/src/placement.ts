import { exerciseFor, type Exercise } from "./exercises";
import { CEFR_ORDER } from "./goal";
import { rng, shuffle } from "./random";
import type { Cefr, LanguagePack, Lesson } from "./schema";
import type { Progress } from "./session";
import { DIRECTIONS, cardKey, newCardState, reviewCard } from "./srs";
import { todayOf } from "./time";

/**
 * 分级测试:学过一些的人不用从"你好"学起。
 * 从最低等级开始,每级抽几个词考(一半看、一半听),答对 80% 才进入下一级;
 * 某一级没过就停,从这一级开始学。
 *
 * 第一版只考词汇理解;后续加入听力和语法题,并用真实作答数据校准题目难度。
 */
export const PASS_RATE = 0.8;

export function placementLevels(lessons: Lesson[]): Cefr[] {
  return CEFR_ORDER.filter((lv) => lessons.some((l) => l.cefr === lv));
}

export function placementQuestions(lessons: Lesson[], pack: LanguagePack, level: Cefr, seed = 1, n = 6): Exercise[] {
  const pool = lessons.filter((l) => l.cefr === level).flatMap((l) => l.newItems);
  const rand = rng(seed);
  return shuffle(pool, rand)
    .slice(0, n)
    .map((it, i) => exerciseFor(it, i % 2 ? "listen" : "recognize", pool, pack, seed + i));
}

export const levelPassed = (correct: number, total: number) => total > 0 && correct / total >= PASS_RATE;

/**
 * 记下测试结果:通过的等级里的课标成"跳过"。这些课的词条直接建卡:
 * 认读、听力按"会"记一次(测试证明大致认得),产出方向留作新卡,之后在复习里确认是不是真会。
 * 不写当天日志——跳过的课不算"今天学了多少"。
 */
export function applyPlacement(p: Progress, lessons: Lesson[], passed: Cefr[], now: Date): Progress {
  const skip = lessons.filter((l) => passed.includes(l.cefr) && !(l.id in p.completed));
  const cards = { ...p.cards };
  const learned = { ...p.learned };
  const day = todayOf(p, now);
  for (const it of skip.flatMap((l) => l.newItems)) {
    learned[it.id] ??= day;
    for (const d of DIRECTIONS) {
      const k = cardKey(it.id, d);
      if (cards[k]) continue;
      const fresh = newCardState(it.id, d, now);
      cards[k] = d === "produce" ? fresh : reviewCard(fresh, "correct", now);
    }
  }
  const skipped = [...new Set([...p.skipped, ...skip.map((l) => l.id)])];
  // 免费单元给"跳级后起步的那个单元",只在第一次确定
  const start = [...lessons].sort((a, b) => a.order - b.order).find((l) => !skipped.includes(l.id) && !(l.id in p.completed));
  return { ...p, cards, learned, skipped, freeUnit: p.freeUnit ?? start?.unit ?? null };
}
