## 你负责的文件
1. **大纲(词条登记)**:每个单元一个文件 content/outlines/{LANG}/a1u{NN}.json(NN 补成两位,如 a1u09.json、a1u12.json),格式照 outline.ts 的 Outline:`{ "lang": "{LANG}", "levels": ["A1"], "units": [{ "unit": "<plan 里的 unit 名>", "cefr": "A1", "themeZh": "…" }], "lessons": [ … ] }`。每节课的 id、type、titleZh、canDoZh、scenarioZh、grammarFocusZh 照 plan;goalZh 一句话;skills 按类型填;order 用 orderFromId(id) 算;estimatedMinutes 填课写好后算出的值。
2. **课**:content/courses/{LANG}/ 下每节课一个文件,文件名是 id 去掉语种前缀,如 a1u9.l01.json、a1u9.r01.json(文件名里单元号不补零)。你负责第 {UNITS} 单元,每个单元 l01–l08 和 r01、r02,共 {COUNT} 个课文件。

## 词条怎么定
- 核心课(l01–l07)每课 8–10 个新词,复习课 l08 新词 ≤ 4 个,读物新词 0–4 个。新词要是这个话题里真正高频、学了能马上用的词和固定说法(参考 {EXAM});{NOUNRULE}
- **不要重复登记**:加新词之前先在 content/outlines/{LANG}.json 和 content/outlines/{LANG}/*.json 里搜一遍(按 id 和写法),已经有的词当复习词用,不要再登记。
- id 用 `{LANG}.<词的小写拉丁写法,空格和撇号换成下划线>`,照已有 id 的起法;同一个词只有一个 id。
- reviewItems:每课 3–6 个前面学过的词,课文里要真的用到。

## 课文只能用学过的词
按课程顺序到本课为止学过的词 = 第 1–8 单元核心大纲({LANG}.json)的词 + 你这几个单元里排在本课前面的课的新词 + 本课新词。**别的同事正在写的课(第 1–8 单元新增的课和读物、A1 其他单元)的词不能用**,它们还没定下来。人名、地名可以用。场景要用到还没教的词,就改写场景绕开,或者把这个词登记成本课新词。每单元课的顺序:l01–l04、r01、l05–l08、r02。
