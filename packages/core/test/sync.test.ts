import { describe, expect, it } from "vitest";
import { completeLesson, emptyProgress, recordAnswer, type Progress } from "../src/session";
import { fromWire, mergeProgress, parseProgress, toWire } from "../src/sync";
import { cardKey } from "../src/srs";
import { lessons } from "./fixtures";

const de = lessons("de");
const at = (day: string, h = 20) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00+08:00`);
/** 模拟存到服务器再取回来:日期变成字符串 */
const viaJson = (p: Progress): Progress => JSON.parse(JSON.stringify(p));

describe("多设备进度合并", () => {
  // 手机学了第一课,平板学了第二课
  let phone = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
  phone = recordAnswer(phone, { itemId: "de.hallo", direction: "produce", verdict: "correct" }, at("2026-11-02"));
  let tablet = completeLesson(emptyProgress("de"), de[1]!, at("2026-11-03"));
  tablet = { ...tablet, goal: { kind: "travel", target: "A2", dailyMinutes: 20 } };

  it("学过的课、词、复习卡都保留", () => {
    const m = mergeProgress(phone, tablet);
    expect(Object.keys(m.completed).sort()).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
    expect(Object.keys(m.learned)).toHaveLength(12);
    expect(m.cards[cardKey("de.hallo", "produce")]!.card.reps).toBe(1);
    expect(m.cards[cardKey("de.vater", "produce")]).toBeDefined();
  });

  it("设置取最近学习的那台设备", () => {
    expect(mergeProgress(phone, tablet).goal?.target).toBe("A2");
  });

  it("和顺序无关,重复合并不变;经过 JSON(日期变字符串)也一样", () => {
    const ab = mergeProgress(phone, tablet);
    const ba = mergeProgress(tablet, phone);
    expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
    expect(JSON.stringify(mergeProgress(ab, tablet))).toBe(JSON.stringify(ab));
    expect(JSON.stringify(mergeProgress(viaJson(phone), viaJson(tablet)))).toBe(JSON.stringify(viaJson(ab)));
  });

  it("同一天两台设备的日志取较大值,不重复计算", () => {
    const p1 = recordAnswer(emptyProgress("de"), { verdict: "correct", skill: "speak", ms: 30_000 }, at("2026-11-05"));
    const m = mergeProgress(p1, p1);
    expect(m.log["2026-11-05"]!.answers).toBe(1);
    expect(m.log["2026-11-05"]!.seconds).toBe(30);
  });

  it("不同语种不能合并", () => {
    expect(() => mergeProgress(emptyProgress("de"), emptyProgress("fr"))).toThrow();
  });
});

describe("合并结果和参数顺序无关(包括分不出新旧的情况)", () => {
  const same = (a: Progress, b: Progress) => expect(JSON.stringify(mergeProgress(a, b))).toBe(JSON.stringify(mergeProgress(b, a)));

  it("两台都还没学(学习时间一样):设置过目标的那份优先;再分不出就按内容定", () => {
    const fresh = emptyProgress("de", 60);
    const onboarded = { ...emptyProgress("de"), goal: { kind: "work" as const, target: "B1" as const, dailyMinutes: 15 } };
    expect(mergeProgress(fresh, onboarded).goal?.target).toBe("B1");
    expect(mergeProgress(onboarded, fresh).goal?.target).toBe("B1");
    same(fresh, onboarded);
    // 只有时区、保护卡数不同
    same(emptyProgress("de", 480), { ...emptyProgress("de", 60), freezes: 1 });
  });

  it("同一天同一节课的两次测验都保留,顺序固定", () => {
    const c = { ...emptyProgress("de"), checkpoints: [{ lessonId: "x", day: "2026-11-01", score: 5 }] };
    const d = { ...emptyProgress("de"), checkpoints: [{ lessonId: "x", day: "2026-11-01", score: 7 }, { lessonId: "x", day: "2026-11-01", score: 5 }] };
    same(c, d);
    expect(mergeProgress(c, d).checkpoints.map((x) => x.score).sort()).toEqual([5, 7]);
  });

  it("复习时间、次数、到期都一样但内容不同的两张卡:按内容挑一张", () => {
    const k = cardKey("de.hallo", "produce");
    const base = recordAnswer(emptyProgress("de"), { itemId: "de.hallo", direction: "produce", verdict: "correct" }, at("2026-11-02"));
    const card = base.cards[k]!;
    const other = { ...base, cards: { [k]: { ...card, card: { ...card.card, stability: card.card.stability + 1 } } } };
    same(base, other);
  });

  it("时间格式坏了(比如被别的版本写坏)也能比较,不会让结果取决于顺序", () => {
    const k = cardKey("de.hallo", "produce");
    const good = recordAnswer(emptyProgress("de"), { itemId: "de.hallo", direction: "produce", verdict: "correct" }, at("2026-11-02"));
    const broken = viaJson(good) as unknown as { cards: Record<string, { card: { last_review: string } }> };
    broken.cards[k]!.card.last_review = "not-a-date";
    same(good, broken as unknown as Progress);
  });

  it("三台设备两两合并,不管顺序:学过的课、词、卡、每天的记录都在,重复合并不变", () => {
    const phone = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
    const tablet = { ...completeLesson(emptyProgress("de"), de[1]!, at("2026-11-03")), goal: { kind: "travel" as const, target: "A2" as const, dailyMinutes: 20 } };
    let laptop = recordAnswer(emptyProgress("de", 60), { itemId: "de.hallo", direction: "listen", verdict: "almost", issues: [{ kind: "accent" }] }, at("2026-11-03", 9));
    laptop = { ...laptop, skipped: ["de.a1u1.l05"], frozenDays: ["2026-10-30"], checkpoints: [{ lessonId: "de.a1u1.l06", day: "2026-11-03", score: 8 }] };
    const all = [phone, tablet, laptop, viaJson(phone), viaJson(tablet), viaJson(laptop)];
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        const m = mergeProgress(a, b);
        same(a, b);
        expect(JSON.stringify(mergeProgress(m, a))).toBe(JSON.stringify(m));
        expect(JSON.stringify(mergeProgress(m, b))).toBe(JSON.stringify(m));
        for (const src of [a, b]) {
          for (const key of ["completed", "learned", "cards", "log"] as const) {
            for (const k of Object.keys(src[key])) expect(m[key], `${key}.${k}`).toHaveProperty([k]);
          }
          for (const s of src.skipped) expect(m.skipped).toContain(s);
          for (const c of src.checkpoints) expect(m.checkpoints).toContainEqual(c);
        }
      }
    }
    const three = [mergeProgress(mergeProgress(phone, tablet), laptop), mergeProgress(mergeProgress(laptop, phone), tablet), mergeProgress(phone, mergeProgress(tablet, laptop))];
    for (const m of three) {
      expect(Object.keys(m.completed).sort()).toEqual(["de.a1u1.l01", "de.a1u1.l02"]);
      expect(m.log["2026-11-03"]!.issues.accent).toBe(1);
      expect(m.issues.accent).toBeDefined();
    }
  });

  it("每天的日志里以后版本加的字段会保留下来", () => {
    const p = recordAnswer(emptyProgress("de"), { verdict: "correct", skill: "speak" }, at("2026-11-05"));
    const withExtra = { ...p, log: { "2026-11-05": { ...p.log["2026-11-05"]!, speakSeconds: 42 } } } as Progress;
    const m = mergeProgress(withExtra, p);
    expect((m.log["2026-11-05"] as unknown as { speakSeconds: number }).speakSeconds).toBe(42);
  });
});

describe("收到的进度先检查结构(parseProgress)", () => {
  const p = recordAnswer(completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01")), { itemId: "de.hallo", direction: "produce", verdict: "correct" }, at("2026-11-02"));

  it("正常的进度(App 里带 Date 的、经过 JSON 的)都能通过,内容不变", () => {
    expect(parseProgress(p)).toEqual(p);
    expect(parseProgress(viaJson(p))).toEqual(viaJson(p));
  });

  it("缺字段的补上默认值;旧版本日志缺的数按 0 补;第一版的格式会转换", () => {
    expect(parseProgress({ lang: "fr" })).toEqual(emptyProgress("fr"));
    const oldDay = parseProgress({ lang: "de", log: { "2026-11-01": { seconds: 60, answers: 3, score: 2, newItems: 0, reviews: 1, drills: 0, lessons: [], issues: {} } } })!;
    expect(oldDay.log["2026-11-01"]!.reviewSessions).toBe(0);
    const v1 = parseProgress({ lang: "de", completedLessons: ["de.a1u1.l01"], activeDays: ["2026-10-30"] })!;
    expect(v1.completed).toEqual({ "de.a1u1.l01": "2026-10-30" });
    expect(v1).not.toHaveProperty("activeDays");
  });

  it("不认识的字段原样保留(新版本 App 加的字段不会因为服务器没升级而丢)", () => {
    expect((parseProgress({ ...viaJson(p), futureField: { x: 1 } }) as unknown as { futureField: unknown }).futureField).toEqual({ x: 1 });
  });

  it("结构不对返回 null(这样的数据合并时会出错)", () => {
    const card = viaJson(p).cards[cardKey("de.hallo", "produce")]!.card;
    const bad: unknown[] = [
      null, 1, "de", [], {},
      { lang: "" },
      { lang: "de", cards: null },
      { lang: "de", cards: { "x#produce": { itemId: "x", direction: "produce" } } },
      { lang: "de", cards: { "x#produce": { itemId: "x", direction: "sideways", card } } },
      { lang: "de", log: { yesterday: {} } },
      { lang: "de", log: { "2026-11-01": { lessons: "l01" } } },
      { lang: "de", skipped: "de.a1u1.l01" },
      { lang: "de", hours: [1, "2"] },
      { lang: "de", goal: { kind: "travel" } },
      { lang: "de", checkpoints: [{ lessonId: "x" }] },
    ];
    for (const b of bad) expect(parseProgress(b), JSON.stringify(b)).toBeNull();
  });
});

describe("同步的紧凑格式", () => {
  let p = completeLesson(emptyProgress("de"), de[0]!, at("2026-11-01"));
  p = completeLesson(p, de[1]!, at("2026-11-01"));
  for (const it of de[0]!.newItems) p = recordAnswer(p, { itemId: it.id, direction: "produce", verdict: "correct" }, at("2026-11-02"));

  it("来回转换不丢信息(复习时间精确到秒)", () => {
    const back = fromWire(JSON.parse(JSON.stringify(toWire(p))))!;
    expect(back).not.toBeNull();
    expect(Object.keys(back.cards).sort()).toEqual(Object.keys(p.cards).sort());
    for (const [k, c] of Object.entries(p.cards)) {
      const b = back.cards[k]!;
      expect(b.itemId).toBe(c.itemId);
      expect(b.direction).toBe(c.direction);
      expect(Math.abs(new Date(b.card.due).getTime() - c.card.due.getTime())).toBeLessThan(1000);
      expect(b.card.reps).toBe(c.card.reps);
      expect(b.card.state).toBe(c.card.state);
      expect(b.card.stability).toBeCloseTo(c.card.stability, 3);
    }
    expect(back.completed).toEqual(p.completed);
    expect(back.log).toEqual(p.log);
  });

  it("体积不到普通格式的一半", () => {
    expect(JSON.stringify(toWire(p)).length).toBeLessThan(JSON.stringify(p).length / 2);
  });

  it("普通格式照样能读;坏数据返回 null", () => {
    expect(fromWire(JSON.parse(JSON.stringify(p)))?.lang).toBe("de");
    expect(fromWire({ wire: 1, lang: "de", cards: { "de.hallo#produce": [1, 2] } })).toBeNull();
    expect(fromWire({ wire: 1, lang: "de", cards: null })).toBeNull();
  });
});
