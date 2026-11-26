import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scoreMemoryMetrics } from "../scripts/memory-metrics.js";

const input = {
  schemaVersion: 1,
  writes: [
    { id: "write-a", label: "relevant" },
    { id: "write-b", label: "neutral" },
    { id: "write-c", label: "noise" },
    { id: "write-d", label: "relevant" },
  ],
  questions: [
    {
      id: "conflict-current",
      kind: "conflict",
      expected: "answer",
      observed: "incorrect",
      staleFactIds: ["version-a", "unused-old-version"],
      recalledFactIds: ["version-a", "version-b", "version-c"],
    },
    {
      id: "conflict-confirmed",
      kind: "conflict",
      expected: "answer",
      observed: "correct",
      staleFactIds: ["version-a"],
      recalledFactIds: ["version-b"],
    },
    {
      id: "historical",
      kind: "temporal",
      expected: "answer",
      observed: "correct",
      staleFactIds: [],
      recalledFactIds: ["version-a"],
    },
    {
      id: "historical-missed",
      kind: "temporal",
      expected: "answer",
      observed: "abstain",
      staleFactIds: [],
      recalledFactIds: [],
    },
    {
      id: "unanswerable",
      kind: "general",
      expected: "abstain",
      observed: "abstain",
      staleFactIds: ["deleted-suggestion"],
      recalledFactIds: ["deleted-suggestion"],
    },
    {
      id: "unanswerable-guessed",
      kind: "conflict",
      expected: "abstain",
      observed: "incorrect",
      staleFactIds: [],
      recalledFactIds: [],
    },
    {
      id: "ordinary-miss",
      kind: "general",
      expected: "answer",
      observed: "incorrect",
      staleFactIds: [],
      recalledFactIds: [],
    },
  ],
};

describe("targeted memory metrics", () => {
  it("scores six metrics with their own populations and question-specific stale labels", () => {
    expect(scoreMemoryMetrics(input)).toEqual({
      schemaVersion: 1,
      writePrecision: { numerator: 2, denominator: 4, value: 1 / 2 },
      noiseRate: { numerator: 1, denominator: 4, value: 1 / 4 },
      conflictResolutionAccuracy: { numerator: 1, denominator: 2, value: 1 / 2 },
      temporalAccuracy: { numerator: 1, denominator: 2, value: 1 / 2 },
      staleRecallRate: { numerator: 2, denominator: 6, value: 1 / 3 },
      abstentionAccuracy: { numerator: 5, denominator: 7, value: 5 / 7 },
    });
  });

  it("keeps an unobserved metric distinct from a measured zero", () => {
    const report = scoreMemoryMetrics({
      schemaVersion: 1,
      writes: [],
      questions: [{ ...input.questions[0], recalledFactIds: [] }],
    });
    expect(report.writePrecision).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(report.noiseRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(report.conflictResolutionAccuracy).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(report.temporalAccuracy).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(report.staleRecallRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(report.abstentionAccuracy).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });

  it.each([
    ["unknown version", { ...input, schemaVersion: 2 }],
    ["empty run", { ...input, writes: [], questions: [] }],
    ["duplicate writes", { ...input, writes: [input.writes[0], input.writes[0]] }],
    ["duplicate questions", { ...input, questions: [input.questions[0], input.questions[0]] }],
    ["unknown write label", { ...input, writes: [{ id: "unknown", label: "ignored" }] }],
    [
      "duplicate recalled facts",
      { ...input, questions: [{ ...input.questions[0], recalledFactIds: ["one", "one"] }] },
    ],
    [
      "duplicate stale labels",
      { ...input, questions: [{ ...input.questions[0], staleFactIds: ["one", "one"] }] },
    ],
    [
      "system-dependent stale labels",
      { ...input, questions: [{ ...input.questions[0], salience: 0.1 }] },
    ],
    [
      "correct response to an unanswerable question",
      {
        ...input,
        questions: [{ ...input.questions[0], expected: "abstain", observed: "correct" }],
      },
    ],
  ])("rejects %s", (_label, payload) => {
    expect(() => scoreMemoryMetrics(payload)).toThrow();
  });
});

describe("memory metrics command", () => {
  function run(payload: unknown) {
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/evaluate-memory.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  it("emits a single JSON report with only counts and scores", () => {
    const result = run(input);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(scoreMemoryMetrics(input));
    expect(result.stdout).not.toContain("version-a");
    expect(result.stdout).not.toContain("conflict-current");
  });

  it("rejects invalid annotations without echoing their contents", () => {
    const result = run({ ...input, credential: "offline-private-sentinel" });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("INVALID_MEMORY_EVALUATION\n");
    expect(result.stdout).toBe("");
  });
});
