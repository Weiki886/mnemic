import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./db-helper.js";

describe("生产迁移入口", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  }, 180000);
  afterAll(async () => {
    await t?.close();
  });
  it("公开可复用的运行函数，真实库重复迁移成功且连接关闭", async () => {
    // dynamic import 使缺少入口时以明确的功能断言失败，而不是收集阶段导入错误。
    const { existsSync } = await import("node:fs");
    expect(existsSync(new URL("../src/db/migrate.ts", import.meta.url))).toBe(true);
    const { migrateDatabase } = await import("../src/db/migrate.js");
    await expect(migrateDatabase(t.url)).resolves.toBeUndefined();
    await expect(migrateDatabase(t.url)).resolves.toBeUndefined();
    const rows = await t.sql`select to_regclass('public.memory_embeddings') as name`;
    expect(rows[0]!.name).toBe("memory_embeddings");
  });
});
