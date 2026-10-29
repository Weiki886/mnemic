import { expect, it } from "vitest";
import { RecallResultSchema } from "../src/memory.js";
import { DEFAULT_FEATURE_FLAGS } from "../src/flags.js";
const base = {
  project_id: "11111111-1111-4111-8111-111111111111",
  query: "query",
  abstained: true,
  candidates: [],
  trace: {
    id: "22222222-2222-4222-8222-222222222222",
    reinforce_enabled: false,
    candidate_count: 0,
    truncated: false,
    candidates: [],
  },
};
it("recall accepts typed snapshots while retaining unknown historical and older-server compatibility", () => {
  const flags_snapshot = { schema_version: 1, revision: 0, flags: DEFAULT_FEATURE_FLAGS };
  expect(
    RecallResultSchema.parse({ ...base, trace: { ...base.trace, flags_snapshot } }).trace
      .flags_snapshot,
  ).toEqual(flags_snapshot);
  expect(
    RecallResultSchema.parse({ ...base, trace: { ...base.trace, flags_snapshot: null } }).trace
      .flags_snapshot,
  ).toBeNull();
  expect(RecallResultSchema.safeParse(base).success).toBe(true);
});
it("recall rejects snapshots inconsistent with its non-reinforcing read contract or with arbitrary content", () => {
  const flags_snapshot = {
    schema_version: 1,
    revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS, read_time_reinforcement: true },
  };
  expect(
    RecallResultSchema.safeParse({ ...base, trace: { ...base.trace, flags_snapshot } }).success,
  ).toBe(false);
  expect(
    RecallResultSchema.safeParse({
      ...base,
      trace: { ...base.trace, flags_snapshot: { ...flags_snapshot, raw_text: "PRIVATE" } },
    }).success,
  ).toBe(false);
});
