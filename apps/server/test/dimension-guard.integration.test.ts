import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertDimensionMatch,
  assertEmbeddingDimensions,
  getEmbeddingColumnDimension,
} from "../src/providers/dimension-guard.js";
import { setupTestDb, type TestDb } from "./db-helper.js";

describe("embedding 维度守卫（#14）", () => {
  it("纯函数：不一致时拒绝并提示 REEMBED 流程", () => {
    expect(() => assertDimensionMatch(1024, 1024)).not.toThrow();
    expect(() => assertDimensionMatch(1024, 512)).toThrow(/REEMBED/);
  });

  describe("集成：读库中真实 vector 列维度", () => {
    let t: TestDb;
    beforeAll(async () => {
      t = await setupTestDb();
    }, 180_000);
    afterAll(async () => {
      await t.close();
    });

    it("memory_embeddings.embedding 列维度可读出（=1024，与 V1 迁移一致）", async () => {
      expect(await getEmbeddingColumnDimension(t.sql)).toBe(1024);
    });

    it("部署配置维度一致时放行；不一致时拒绝启动语义（抛错含 REEMBED）", async () => {
      await expect(assertEmbeddingDimensions(t.sql, 1024)).resolves.toBeUndefined();
      await expect(assertEmbeddingDimensions(t.sql, 512)).rejects.toThrow(/REEMBED/);
    });

    it("空库（未迁移）拒绝启动时抛友好提示，而非裸 PostgresError", async () => {
      // 复现 #60：'...'::regclass 在表不存在时直接抛错，友好提示分支不可达
      const emptyDbName = `mnemic_empty_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const admin = postgres(t.url, { max: 1 });
      await admin.unsafe(`CREATE DATABASE ${emptyDbName}`);
      const emptyUrl = t.url.replace(/\/[^/?]+(?=\?|$)/, `/${emptyDbName}`);
      const emptySql = postgres(emptyUrl, { max: 1 });
      try {
        await expect(getEmbeddingColumnDimension(emptySql)).rejects.toThrow(/迁移未执行/);
        await expect(assertEmbeddingDimensions(emptySql)).rejects.toThrow(/迁移未执行/);
      } finally {
        await emptySql.end({ timeout: 1 }).catch(() => {});
        await admin.unsafe(`DROP DATABASE ${emptyDbName}`);
        await admin.end({ timeout: 1 }).catch(() => {});
      }
    });
  });
});
