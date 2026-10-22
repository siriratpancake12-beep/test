# 学外语(暂名)

面向中国学习者的外语 App,一套代码上架苹果和安卓。首发英语、法语、德语,随后日语、韩语、西班牙语。

- [参考项目评估(泰好说)](docs/01-参考项目评估.md):它的优点、问题,以及新系统改进在哪里
- [新系统架构设计](docs/02-新系统架构设计.md):技术选型、内容格式、服务器、路线图
- [语种选择与上架合规](docs/03-语种选择与上架合规.md):做哪些语种、App Store 和国内安卓商店需要准备什么
- [续订与学习效果方案](docs/04-续订与学习效果方案.md):怎么让用户因为"真的学会了"而一直续订
- [决策记录](docs/05-决策记录.md):已经做的决定,以及需要负责人拍板的事

## 目录

```
apps/mobile/      App(Expo / React Native)
packages/core/    学习引擎:内容格式、判题、间隔复习、练习生成、内容校验;
                  每日计划、弱点专练、目标预估、周报、连续天数、提醒、会员订阅
tests/e2e/        端到端测试
content/          语言包和课程(JSON)
tools/            内容检查、生成 App 内容索引
docs/             文档
```

## 常用命令

```
npm install                    # 安装依赖(根目录,npm workspaces)
npm test                       # 引擎测试
npm run typecheck              # 引擎 + App 类型检查
npm run validate               # 检查全部课程内容
npm run content:index          # 加课以后重新生成 App 的内容索引
npm run e2e                    # 端到端测试:打包网页版,用真浏览器走一遍主要流程
cd apps/mobile && npx expo start   # 启动 App 开发服务器,手机扫码预览(用到通知等原生模块,需要开发版 App:npx expo run:ios|android)
cd apps/mobile && npx expo start --web   # 网页预览(给团队看界面用;通知在网页上不可用)
```

## 加一节课

1. 在 `content/courses/<语种>/` 下新建 JSON(格式见 `packages/core/src/schema.ts`,可以照着已有的课写)。
   每节课必须写 `canDoZh`(学完能做到什么),周报里会给学习者看。
2. `npm run validate`:0 个问题才算通过(会检查冠词和性别一致、课文只用学过的词等)。
3. `npm run content:index`,然后在 App 里看效果。
4. 上线前必须由母语老师审校,把 `review` 改成 `native`。
