import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scoreRetrievalComparison } from "../scripts/retrieval-comparison.js";

const id = (suffix: string) => `abcdefab-0000-7000-8000-${suffix.padStart(12, "0")}`;
const a = id("a");
const b = id("b");
const c = id("c");
const run = (trace: string, ...rankedVersionIds: string[]) => ({
  traceId: id(trace),
  rankedVersionIds,
});
const comparisons = () => ({
  k: 2,
  cases: [
    {
      id: "two-relevant",
      relevantVersionIds: [a, b],
      baseline: run("1", c, a, b),
      variant: run("2", a.toUpperCase(), b),
    },
    {
      id: "miss",
      relevantVersionIds: [c],
      baseline: run("3"),
      variant: run("4", a, b, c),
    },
    {
      id: "no-answer",
      relevantVersionIds: [],
      baseline: run("5"),
      variant: run("6", a),
    },
  ],
});

describe("paired retrieval comparison", () => {
  it("uses macro averages, honors K, and keeps misses distinct from abstentions", () => {
    const result = scoreRetrievalComparison(comparisons());
    expect(result).toMatchObject({
      k: 2,
      counts: { cases: 3, answerable: 2, unanswerable: 1 },
      baseline: { hitAtK: 0.5, recallAtK: 0.25, mrrAtK: 0.25, abstentionAccuracy: 2 / 3 },
      variant: { hitAtK: 0.5, recallAtK: 0.5, mrrAtK: 0.5, abstentionAccuracy: 2 / 3 },
      delta: { hitAtK: 0, recallAtK: 0.25, mrrAtK: 0.25, abstentionAccuracy: 0 },
    });
    expect(result.cases[1]).toMatchObject({
      id: "miss",
      baseline: { traceId: id("3"), hitAtK: 0, abstained: true, correctAbstention: false },
      variant: { traceId: id("4"), hitAtK: 0, abstained: false, correctAbstention: true },
    });
    expect(result.cases[2]).toMatchObject({
      id: "no-answer",
      baseline: { hitAtK: null, recallAtK: null, mrrAtK: null, correctAbstention: true },
      variant: { hitAtK: null, recallAtK: null, mrrAtK: null, correctAbstention: false },
    });
  });

  it("reports undefined ranking metrics as null for an all-unanswerable dataset", () => {
    const input = comparisons();
    const result = scoreRetrievalComparison({ ...input, cases: [input.cases[2]] });
    expect(result.baseline).toEqual({
      hitAtK: null,
      recallAtK: null,
      mrrAtK: null,
      abstentionAccuracy: 1,
    });
    expect(result.delta).toEqual({
      hitAtK: null,
      recallAtK: null,
      mrrAtK: null,
      abstentionAccuracy: -1,
    });
  });

  it.each([
    ["missing case", { ...comparisons(), cases: [] }],
    ["invalid k", { ...comparisons(), k: 201 }],
    ["unknown fields", { ...comparisons(), providerKey: "private" }],
    ["duplicate cases", { k: 2, cases: [...comparisons().cases, comparisons().cases[0]] }],
    [
      "duplicate gold",
      { k: 2, cases: [{ ...comparisons().cases[0], relevantVersionIds: [a, a.toUpperCase()] }] },
    ],
    [
      "duplicate rank",
      { k: 2, cases: [{ ...comparisons().cases[0], baseline: run("1", a, a.toUpperCase()) }] },
    ],
    ["reused trace", { k: 2, cases: [{ ...comparisons().cases[0], variant: run("1", b) }] }],
    ["missing arm", { k: 2, cases: [{ ...comparisons().cases[0], variant: undefined }] }],
    ["invalid case id", { k: 2, cases: [{ ...comparisons().cases[0], id: "hidden input" }] }],
  ])("rejects %s", (_label, input) => {
    expect(() => scoreRetrievalComparison(input)).toThrow();
  });
});

describe("evaluation command", () => {
  function execute(input: string | Buffer) {
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/evaluate-retrieval.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      input,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  it("reads JSON from stdin and outputs only the report", () => {
    const input = comparisons();
    const result = execute(JSON.stringify(input));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(scoreRetrievalComparison(input));
  });

  it.each([
    ["malformed JSON", "private-input"],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["oversized input", Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)],
  ])("rejects %s without echoing input", (_label, input) => {
    const result = execute(input as string | Buffer);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("INVALID_RETRIEVAL_COMPARISON\n");
  });
});
