import { useEffect, useState } from "react";
import type { Line } from "@lingo/core";
import { storage } from "../storage";
import { Button } from "./Button";

/**
 * 课文句子的读音:日语的整句假名(reading)、日韩的罗马音(roman)。课程里写了才有(入门阶段)。
 * 显示在原文下面,课文、跟读、角色扮演通用;学习者可以关掉(看熟了想只看原文),开关记在本机,所有课通用。
 */
const KEY = "pref:showReading";

/** 这句的读音,一行一种;没有返回 undefined */
export const readingOf = (l: Line): string | undefined => {
  const parts = [l.reading, l.roman].filter((x): x is string => !!x && x.trim().length > 0);
  return parts.length ? parts.join("\n") : undefined;
};

let cached: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

/** 读音开关:has = 这些句子里有没有读音(没有就不用显示开关) */
export function useReading(lines: Line[]) {
  const [show, setShow] = useState(cached ?? true);
  useEffect(() => {
    listeners.add(setShow);
    if (cached === null) {
      storage.getItem(KEY)
        .then((v) => {
          cached = v !== "off";
          listeners.forEach((fn) => fn(cached!));
        })
        .catch(() => {});
    }
    return () => {
      listeners.delete(setShow);
    };
  }, []);
  const toggle = () => {
    cached = !show;
    listeners.forEach((fn) => fn(cached!));
    storage.setItem(KEY, cached ? "on" : "off").catch(() => {});
  };
  return { has: lines.some((l) => !!readingOf(l)), show, toggle };
}

/** "显示读音 / 隐藏读音"按钮;句子里没有读音时不显示 */
export function ReadingToggle({ reading }: { reading: ReturnType<typeof useReading> }) {
  if (!reading.has) return null;
  return <Button ghost testID="reading-toggle" title={reading.show ? "隐藏读音" : "显示读音"} onPress={reading.toggle} />;
}
