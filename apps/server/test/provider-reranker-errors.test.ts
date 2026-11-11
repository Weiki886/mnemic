import { expect, it } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolveProviderRerankerConfig } from "../src/providers/reranker.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
it("a resolver storage failure cannot expose database exception details", async () => {
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      throw Error("private-sql-key-credential");
    },
  });
  await expect(
    resolveProviderRerankerConfig(db, TEST_MASTER_KEY, "01900000-0000-7000-8000-000000000001"),
  ).rejects.toThrow(/^RERANKER_CONFIG_UNAVAILABLE$/);
});
