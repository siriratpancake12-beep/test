import { defineConfig } from "vitest/config";

// 每个测试文件都要启动一个内嵌数据库(PGlite),机器忙或多个文件并行时会慢,默认 5 秒不够
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
