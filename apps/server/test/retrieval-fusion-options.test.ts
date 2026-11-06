import { expect, it } from "vitest";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { buildRankFusionQuery } from "../src/retrieval/fusion.js";
const flags = { ...DEFAULT_FEATURE_FLAGS };
it.each([
  null,
  false,
  {},
  { mode: "rrf" },
  { mode: "unknown", flags },
  { mode: "rrf", flags, table: "beliefs" },
  { mode: "rrf", flags: { ...flags, retrieval_vector: 1 } },
  { mode: "rrf", flags: { retrieval_vector: true } },
  ...[0, -1, 1.5, 1001, "60", NaN, Infinity, null].map((k) => ({ mode: "rrf", flags, k })),
  ...[0, 201, 1.5, Infinity, "2"].map((perRouteLimit) => ({ mode: "rrf", flags, perRouteLimit })),
  ...[0, 801, 1.5, "2"].map((maxCandidates) => ({ mode: "rrf", flags, maxCandidates })),
  { mode: "weighted", flags },
  { mode: "weighted", flags, k: 60, weights: { vector: 1, keyword: 0, entity: 0, time: 0 } },
  ...[
    { vector: 1, keyword: 0, entity: 0 },
    { vector: 1, keyword: 1, entity: 0, time: 0 },
    { vector: -1, keyword: 1, entity: 1, time: 0 },
    { vector: NaN, keyword: 1, entity: 0, time: 0 },
    { vector: 1, keyword: 0, entity: 0, time: 0, extra: 1 },
  ].map((weights) => ({ mode: "weighted", flags, weights })),
])(
  "invalid options %# fail synchronously with a fixed error before any database access",
  (value) => {
    expect(() => buildRankFusionQuery(value)).toThrow("INVALID_FUSION_OPTIONS");
  },
);
it("accepted boundary options produce SQL without altering caller input or needing database/models", () => {
  const input = Object.freeze({
    mode: "rrf",
    flags: Object.freeze({ ...flags }),
    k: 1000,
    perRouteLimit: 200,
    maxCandidates: 800,
  });
  const before = JSON.stringify(input);
  expect(buildRankFusionQuery(input)).toBeDefined();
  expect(JSON.stringify(input)).toBe(before);
  expect(
    buildRankFusionQuery({
      mode: "weighted",
      flags,
      weights: { vector: 0.25, keyword: 0.25, entity: 0.25, time: 0.25 },
    }),
  ).toBeDefined();
});
