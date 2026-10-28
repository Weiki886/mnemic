import { describe, expect, it } from "vitest";
import {
  FeatureFlagsSchema,
  FeatureFlagSnapshotSchema,
  FeatureFlagUpdateSchema,
  DEFAULT_FEATURE_FLAGS,
  createFeatureFlagSnapshot,
} from "../src/flags.js";
const expected = {
  retrieval_vector: true,
  retrieval_keyword: true,
  retrieval_entity: false,
  retrieval_time: false,
  memory_gate: true,
  decay: false,
  reranker: false,
  authority_resolution: true,
  read_time_resolution: false,
  read_time_reinforcement: false,
};
describe("feature flag configuration v1", () => {
  it("defaults preserve existing behavior and leave experimental/unimplemented modules off", () => {
    expect(DEFAULT_FEATURE_FLAGS).toEqual(expected);
    expect(Object.isFrozen(DEFAULT_FEATURE_FLAGS)).toBe(true);
  });
  it("represents all 1024 independent ablation combinations", () => {
    const keys = Object.keys(expected);
    for (let bits = 0; bits < 1024; bits++) {
      const flags = Object.fromEntries(keys.map((k, i) => [k, (bits & (1 << i)) !== 0]));
      expect(FeatureFlagsSchema.parse(flags)).toEqual(flags);
    }
  });
  it.each([undefined, "false", 0, null])("rejects missing/coerced booleans: %s", (value) => {
    expect(FeatureFlagsSchema.safeParse({ ...expected, memory_gate: value }).success).toBe(false);
  });
  it("rejects unknown fields and requires a complete snapshot for replacement", () => {
    expect(FeatureFlagsSchema.safeParse({ ...expected, raw_text: "PRIVATE" }).success).toBe(false);
    expect(
      FeatureFlagUpdateSchema.safeParse({ expected_revision: 0, flags: { memory_gate: false } })
        .success,
    ).toBe(false);
    expect(
      FeatureFlagUpdateSchema.safeParse({ expected_revision: 0, flags: expected, actor: "spoof" })
        .success,
    ).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"])("rejects unsafe revision %s", (revision) => {
    expect(
      FeatureFlagSnapshotSchema.safeParse({ schema_version: 1, revision, flags: expected }).success,
    ).toBe(false);
    expect(
      FeatureFlagUpdateSchema.safeParse({ expected_revision: revision, flags: expected }).success,
    ).toBe(false);
  });
  it("rejects unknown snapshot versions and secret-bearing extensions", () => {
    expect(
      FeatureFlagSnapshotSchema.safeParse({ schema_version: 2, revision: 0, flags: expected })
        .success,
    ).toBe(false);
    expect(
      FeatureFlagSnapshotSchema.safeParse({
        schema_version: 1,
        revision: 0,
        flags: expected,
        api_key: "PRIVATE",
      }).success,
    ).toBe(false);
  });
  it("snapshots are frozen isolated copies for later trace persistence", () => {
    const source = { schema_version: 1, revision: 0, flags: { ...expected } };
    const snapshot = createFeatureFlagSnapshot(source);
    source.flags.memory_gate = false;
    expect(snapshot.flags.memory_gate).toBe(true);
    expect(() => {
      (snapshot.flags as Record<string, boolean>).memory_gate = false;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot as { revision: number }).revision = 3;
    }).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
      schema_version: 1,
      revision: 0,
      flags: expected,
    });
  });
});
