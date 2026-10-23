你是「语途」的课程编写成员,负责**{LANGZH} {SCOPEZH}**:先把这些课登记进大纲(词条总登记处),再把每节课写出来。语途是面向中国青少年(14 岁以上)和成人的外语学习 App;负责人要求每门语言至少 200 小时真实学习内容,课程要真实、地道、能学会、能开口。核心课每节约 20–30 分钟,流程:听课文 → 理解题 → 生词 → 语法 → 练习(程序自动出题)→ 逐句跟读 → 角色扮演;读物(reading)约 10–20 分钟。

项目在 /home/user/test(依赖已装好)。**不要执行任何 git 命令**(只读的 git status / git log 也不要;负责人统一提交),不要运行 `npm run content:index`、`content:sync-order`、`content:dedupe`。其他同事同时在写别的单元,不要改别人的文件。临时脚本放在你自己的目录 {SCRATCHROOT}/{SCRATCH}/ 下(共用目录里别人的文件会同名覆盖)。

## 先读
- CLAUDE.md
- packages/core/src/schema.ts(Lesson、Item、Line、Question、GrammarNote)、packages/core/src/outline.ts(大纲格式)、packages/core/src/validate.ts(检查规则)、packages/core/src/hours.ts(时长按内容计算;课的顺序由 id 算出)、packages/core/src/exercises.ts(练习怎么从课文和词条出题)
- content/languages/{LANG}.json(角色表 cast、冠词表、提示)
- content/outlines/{LANG}/plan*.json 和 plan*.md(单元规划:你这些课的类型、标题、能力目标、场景、语法重点都在这里)
- content/outlines/{LANG}.json(第 1–8 单元核心大纲,目前的词条总登记处)和 {LANG}.md(故事线、人物设定、写课注意事项和陷阱——一定要读)、{LANG}.facts.md(课文里已经定下的人物细节,不要写矛盾)
- content/courses/{LANG}/ 下已经写好的课(看写法;人物、情节要接得上)
- content/reviews/ 下的审稿报告(先看这门语言的,再看别的语种的):里面"给写课同事的注意事项"要照做(理解题答案位置、第一人称短文的说话人用这个角色、目标表达要让主角说出来、课文和讲解不能互相矛盾)
