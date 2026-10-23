你是「语途」的课程总设计之一,负责**{LANGZH}课程的单元规划**(这一步只做规划,不写词条和课文)。语途是面向中国青少年(14 岁以上)和成人的外语学习 App;负责人要求**每门语言至少 200 小时真实学习内容**:A1 共 20 个单元(每单元 8 课 + 2 篇读物)、A2 共 30 个单元(每单元 8 课 + 3 篇读物),每节课约 20–30 分钟。

项目在 /home/user/test。**不要执行任何 git 命令**(只读的也不要),只写下面三个文件。临时文件放在 {SCRATCHROOT}/{LANG}-plan/ 下。

## 先读
CLAUDE.md;content/outlines/{LANG}.json 或 content/outlines/{LANG}/a1u*.json 和 {LANG}.md(A1 核心大纲:第 1–8 单元,每单元 l01–l05 和复习课 l08)、{LANG}.facts.md;content/languages/{LANG}.json(cast);packages/core/src/schema.ts、hours.ts(课的 id 和顺序:A1 读物 r01 在 l04 后、r02 在 l08 后;A2 的 r01/r02/r03 在 l03/l06/l08 后)。别的语种已经写好的 content/outlines/*/plan.json 可以参考格式和粒度。

## 你要写的文件
- content/outlines/{LANG}/plan.json:A1(第 1–8 单元新增的 l06、l07、r01、r02 + 第 9–20 单元每单元 l01–l08、r01、r02)——**先写这个**
- content/outlines/{LANG}/plan-a2.json:A2 第 1–30 单元(id a2u1–a2u30,每单元 l01–l08、r01–r03)
- content/outlines/{LANG}/plan.md:故事线怎么发展、每个单元一句话、语法和发音的分布、补的高频词、给写课同事的注意事项、新定的人物细节

文件很大,**分几次写**(先建文件,再用编辑追加),单次输出不要太长。

## 格式
`{ "lang": "{LANG}", "units": [ { "id": "a1u9", "unit": "A1-9 …", "cefr": "A1", "themeZh": "…", "grammarZh": "…", "pronunciationZh": "…", "lessons": [ { "id": "{LANG}.a1u9.l01", "type": "dialogue|vocab|grammar|reading", "titleZh": "…", "canDoZh": "能……", "scenarioZh": "场景和人物(只用 cast 里的角色或 narrator,末尾写建议的说话人)", "grammarFocusZh": "…" } ] } ] }`
- 第 1–8 单元的 unit 名和已有大纲一致;新增两课换新情境或新技能,不和 l01–l05 重复。
- 语法和话题循序渐进;同一个语法点首次讲解只出现一次;按{EXAM}的进程。
- 写课同事反馈过的"大纲漏掉的高频词"要排进合适的课(看 {LANG}.facts.md 和 content/reviews/)。

写完检查:plan.json 20 个单元、152 条;plan-a2.json 30 个单元、330 条;id 不重复。

## 最后的报告(给负责人,简洁,中文)
完成情况、条目数、语法分布概况、需要注意的地方、新定的人物细节。
