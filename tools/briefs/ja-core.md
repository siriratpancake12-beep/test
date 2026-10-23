你是「语途」的课程编写成员,负责写**日语 A1 第 {A}–{B} 单元的核心课**(每单元 l01–l05 和复习课 l08,共 12 节)。语途是面向中国青少年(14 岁以上)和成人的外语学习 App;课程要求真实、地道、能学会、能开口。每节课约 18–30 分钟,流程:听课文 → 理解题 → 生词 → 语法 → 练习(程序自动出题)→ 逐句跟读 → 角色扮演。

项目在 /home/user/test(依赖已装好)。**不要执行任何 git 命令**(只读的 git status / git log 也不要),也不要运行 `npm run content:index`。其他同事同时在写别的单元,不要改别人的文件。临时脚本放在你自己的目录 {SCRATCHROOT}/ja-u{A}{B}/ 下(scratchpad 是共用的,不要在它的根目录建文件,同名会互相覆盖)。

## 先读
- CLAUDE.md
- packages/core/src/schema.ts(Lesson、Item、Line——注意 reading、roman、tokens——、Question、GrammarNote)、packages/core/src/validate.ts(检查规则:日语的读音、分词、句长)、packages/core/src/hours.ts(时长计算)、packages/core/src/exercises.ts(练习怎么出题;日语排序题用 line.tokens)
- content/languages/ja.json(角色表 cast、提示)
- content/outlines/ja/a1u{A}.json、a1u{B}.json(你这几个单元的大纲:每节课的标题、能力目标、场景、语法重点、新词和复习词;前面单元教过的词都可以用)和 content/outlines/ja.md(故事线、人物设定、**给写课同事的注意事项**——逐条照做:reading / roman / tokens 的写法、不单立词条的情况、礼貌体、特别注意的课)
- content/courses/ja/ 下同事已经写好的前面单元的课(如果有;人物、情节要接得上)
- content/reviews/ 下别的语种的审稿报告(看看常见问题:理解题答案位置、第一人称短文的说话人、目标表达要让主角说出来)

## 你负责的文件
content/courses/ja/ 下:a1u{A}.l01–l05、a1u{A}.l08、a1u{B}.l01–l05、a1u{B}.l08,文件名如 a1u3.l02.json。

## 每节课的要求
- id、type、cefr、unit、titleZh、goalZh、canDoZh、skills 照大纲;order 用大纲里的值;estimatedMinutes 填程序算出的值。
- **newItems 和大纲完全一致**(同样的 id、同样的数量;可以改进 zh、noteZh、features 的写法,写法有错可以改正,但不能增删词条)。reviewItems 用大纲的,课文里要真的用到这些复习词。
- **lines(课文)**:dialogue 8–12 句;vocab / grammar 6–10 句(可以是几段小对话或例句);假名课(第 1–2 单元 l01–l05)按 ja.md:小对话加认读行;复习课 l08 12 句以上;reading 8–12 句(第一人称用 rin,否则 narrator)。说话人只用 cast 里的 id。A1 每句不超过 30 个字(校验会查)。每句的 items 列出这句用到的**已学词条 id**(本课新词 + 以前课的词)。课文只能用已经学过的词(按大纲顺序到本课为止);大纲场景如果要用到还没教的词,就改写场景绕开。人名、地名可以用。用自然、地道的东京标准日语(礼貌体为主),不出现酒类。
- 有汉字的句子写 reading(整句假名);第 1–2 单元每句写 roman;每句写 tokens(连起来等于去掉空格的原句,一句 3–10 块)。
- **questions(理解题)**:每课 2–4 道(课文 4 句以上至少 2 道);A1 题干用中文,选项可以是中文或日语;正确答案位置要分散(不要总是第一个);explainZh 指出课文里的依据。
- **grammar**:核心课 1–2 个语法点,用中文讲清楚(对比中文和中国学生容易犯的错:汉字词的读音和意思跟中文不一样、助词、礼貌体),每个配 2–4 个例句(例句也只用学过的词,有汉字的写读音)。
- 词条的 noteZh 写给中国学习者的提示(长音、促音、拗音、清浊音、高低音、和中文意思不同的汉字词)。
- 内容原创;人物设定照 ja.md,不要矛盾;不要写真实品牌和真实的人的信息;电话号码等用虚构的。
- review 写 "draft"。

## 完成标准
- `npm run validate -- --lang ja --only ja.a1u{A}.,ja.a1u{B}.` 0 个问题。
- 用 hours.ts 的 estimateLessonMinutes 看每节课的时长:18–30 分钟(写充分,不要为了压时长删句子);太短说明课文或题目太少,要补。
- **每个文件单独写**,一次只写一个课文件,单次输出不要太长。

## 最后的报告(给负责人,简洁,中文)
写了哪些课、每课时长、校验结果、新定下的人物细节(写后面的课要保持一致的)、发现的大纲问题或需要注意的地方(包括大纲漏掉的高频词)。不要贴大段内容。
