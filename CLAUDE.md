# 给 AI 助手和开发者的说明

- 回复和文档一律用**简体中文**;代码注释也用中文,说清"为什么",不啰嗦,风格照着已有代码。
- 产品:「语途」,面向中国的**青少年(14 岁以上)和成人**学外语,先做英语、法语、德语。产品原则见 `docs/04-续订与学习效果方案.md`:续订靠学习效果,不靠套路;复习永远免费;付费页只写已经做好的功能。
- 决策和需要负责人确认的事记在 `docs/05-决策记录.md`。花钱、用公司/个人身份办手续、法律文本定稿,要负责人同意;其他技术和产品决定可以直接做,做完记下来。

## 结构
- `packages/core` 学习引擎(内容格式、判题、复习、计划、会员状态、接口约定 `api.ts`、埋点 `events.ts`、进度合并 `sync.ts`)
- `packages/billing` 支付校验 · `services/api` 服务器(Fastify + Kysely,开发/测试用 PGlite,生产用 Postgres)
- `apps/mobile` App(Expo / React Native)· `content/` 语言包、大纲、课程、口语场景 · `tools/` 内容工具 · `tests/e2e` 端到端测试

## 检查(提交前要全部通过)
```
npm test                 # 所有包的单元测试
npm run typecheck        # 所有包的类型检查
npm run validate         # 课程内容检查(分头写课用 -- --lang de --only de.a1u3)
npm run e2e              # 端到端测试(需要 Chromium;本机用 CHROMIUM_PATH=/opt/pw-browsers/chromium)
```

## 规则
- 已发布的课 id、词条 id **永远不改**(学习者的进度和复习卡靠它)。
- 课程:每节课必须有 `canDoZh`;德法名词连冠词写并标性别,德语名词标复数;课文说话人必须在语言包的 `cast` 里;课文只能用已经教过的词条;写好的课的新词必须和大纲一致。
- 内容是原创的,不抄教材。AI 写、AI 审的课 `review` 标 `ai`;正式上线前要母语老师审成 `native`。
- 不提交任何密钥、签名文件;服务器密钥只放环境变量。
- 改了 `content/` 以后运行 `npm run content:index` 更新 App 的内容索引。
