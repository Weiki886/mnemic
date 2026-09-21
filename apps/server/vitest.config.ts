import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mnemic/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    pool: "forks",
    // 集成测试共享同一测试库（行级状态与 advisory lock 语义），
    // 单进程串行执行消除跨文件竞态；单测规模小，串行代价可忽略
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
  },
});
