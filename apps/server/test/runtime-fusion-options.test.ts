import { expect, it } from "vitest";
import { parseRuntimeFusion } from "../src/retrieval/runtime-fusion.js";
const rrf = { mode: "rrf", threshold: 0.01 };
it("requires an explicit threshold and uses the shared bounded fusion defaults", () => {
  expect(parseRuntimeFusion(rrf)).toEqual({
    mode: "rrf",
    k: 60,
    perRouteLimit: 200,
    maxCandidates: 200,
    threshold: 0.01,
  });
  expect(parseRuntimeFusion(undefined)).toBeUndefined();
});
it.each([
  null,
  {},
  { mode: "rrf" },
  { ...rrf, threshold: NaN },
  { ...rrf, threshold: -1 },
  { ...rrf, threshold: 1.1 },
  { ...rrf, k: 0 },
  { ...rrf, k: 1001 },
  { ...rrf, perRouteLimit: 201 },
  { ...rrf, maxCandidates: 801 },
  { ...rrf, flags: {} },
  { ...rrf, unexpected: "secret" },
  { mode: "weighted", threshold: 0.1, weights: { vector: 0.7, keyword: 0.4, entity: 0, time: 0 } },
])("rejects invalid explicit options %# with a fixed error", (value) => {
  expect(() => parseRuntimeFusion(value)).toThrow(/^INVALID_RUNTIME_FUSION_OPTIONS$/);
});
it("clones weighted coefficients so caller mutation cannot change an in-flight operation", () => {
  const input = {
    mode: "weighted",
    threshold: 0.2,
    weights: { vector: 0.7, keyword: 0.3, entity: 0, time: 0 },
  };
  const parsed = parseRuntimeFusion(input);
  input.weights.vector = 0;
  expect(parsed).toEqual({
    ...input,
    perRouteLimit: 200,
    maxCandidates: 200,
    weights: { vector: 0.7, keyword: 0.3, entity: 0, time: 0 },
  });
});
