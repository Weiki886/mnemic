import { expect, it } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DEFAULT_FEATURE_FLAGS, createFeatureFlagSnapshot } from "@mnemic/shared/flags";
import { captureFeatureFlags } from "../src/flags/runtime.js";
const db = new Proxy({} as PostgresJsDatabase, {
  get() {
    throw Error("DB must not be read");
  },
});
it("a trusted snapshot is cloned/frozen synchronously and wins over later override options", async () => {
  const input = { schema_version: 1 as const, revision: 3, flags: { ...DEFAULT_FEATURE_FLAGS } };
  const result = captureFeatureFlags(db, { flagsSnapshot: input, reinforce: true });
  input.flags.memory_gate = false;
  const snapshot = await result;
  expect(snapshot.flags.memory_gate).toBe(true);
  expect(snapshot.flags.read_time_reinforcement).toBe(false);
  expect(Object.isFrozen(snapshot.flags)).toBe(true);
});
it.each([
  "retrieval_entity",
  "retrieval_time",
  "decay",
  "reranker",
  "read_time_resolution",
] as const)("unsupported %s cannot silently pretend to run", async (key) => {
  const flagsSnapshot = createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS, [key]: true },
  });
  await expect(captureFeatureFlags(db, { flagsSnapshot })).rejects.toThrow(
    "unsupported feature flag enabled",
  );
});
it("invalid externally forged snapshot is rejected before database/model access", async () => {
  await expect(
    captureFeatureFlags(db, {
      flagsSnapshot: {
        schema_version: 1,
        revision: 0,
        flags: { ...DEFAULT_FEATURE_FLAGS, api_key: "PRIVATE" },
      } as never,
    }),
  ).rejects.toThrow();
});
it.each([null, false, 0])(
  "explicit malformed snapshot %s cannot fall back to a database read",
  async (value) => {
    await expect(captureFeatureFlags(db, { flagsSnapshot: value as never })).rejects.toMatchObject({
      name: "ZodError",
    });
  },
);
