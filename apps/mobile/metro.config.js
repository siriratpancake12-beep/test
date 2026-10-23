// Metro 打包配置。
// 打包缓存放在本项目目录里(默认在系统临时目录,几个工作区共用,会把别处的打包结果串进来——
// 比如把测试用的服务器地址带进正式包)。
const path = require("path");
const { execFileSync } = require("child_process");
const { getDefaultConfig } = require("expo/metro-config");
const { FileStore } = require("metro-cache");

// 内置课程(src/content/*.generated.ts)不提交,每次启动打包器时按 content/ 重新生成:开发服务器、
// expo export(npm run build:web、e2e)、EAS 云端打包都会先经过这里,打进包里的永远是当前的课程。
// 课程格式不对时生成失败,打包也跟着停下(错误列在上面)。开发服务器开着时改了课,运行 npm run content:index,App 会自动刷新。
// LINGO_CONTENT_DIR 换一个内容目录(压测 tools/bench-content.ts 用假的全量课程打包)。
execFileSync(
  process.execPath,
  [
    require.resolve("tsx/cli"),
    path.join(__dirname, "..", "..", "tools", "gen-content-index.ts"),
    ...(process.env.LINGO_CONTENT_DIR ? ["--content", process.env.LINGO_CONTENT_DIR] : []),
  ],
  { stdio: "inherit" },
);

const config = getDefaultConfig(__dirname);
config.cacheStores = [new FileStore({ root: path.join(__dirname, ".metro-cache") })];
module.exports = config;
