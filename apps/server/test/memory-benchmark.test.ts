import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildMemoryBenchmark } from "../scripts/memory-benchmark.js";
import { scoreMemoryMetrics } from "../scripts/memory-metrics.js";

it("provides 100 questions in 20 isolated synthetic project histories", () => {
  const dataset = buildMemoryBenchmark();
  expect(dataset).toMatchObject({ schemaVersion: 1, datasetId: "mnemic-synthetic-v1" });
  const { projects } = dataset;
  expect(projects).toHaveLength(20);
  expect(new Set(projects.map((project) => project.id)).size).toBe(20);
  expect(new Set(projects.map((project) => project.topic)).size).toBe(20);
  const questions = projects.flatMap((project) => project.questions);
  expect(questions).toHaveLength(100);
  expect(new Set(questions.map((question) => question.id)).size).toBe(100);
  expect(questions.filter((question) => question.kind === "conflict")).toHaveLength(40);
  expect(questions.filter((question) => question.kind === "temporal")).toHaveLength(20);
  expect(questions.filter((question) => question.gold.expected === "abstain")).toHaveLength(40);
});

it("grounds every label in the visible session prefix and uses only local fact IDs", () => {
  const { projects } = buildMemoryBenchmark();
  const evidenceIds = projects.flatMap((project) =>
    project.sessions.flatMap((session) => session.messages.map((message) => message.id)),
  );
  expect(new Set(evidenceIds).size).toBe(evidenceIds.length);

  for (const project of projects) {
    expect(project.questions).toHaveLength(5);
    expect(project.sessions.map((session) => session.recordedAt)).toEqual(
      project.sessions.map((session) => session.recordedAt).sort(),
    );
    const facts = new Map(project.facts.map((fact) => [fact.id, fact]));
    for (const question of project.questions) {
      const cutoff = project.sessions.findIndex(
        (session) => session.id === question.untilSessionId,
      );
      expect(cutoff).toBeGreaterThanOrEqual(0);
      const visible = project.sessions.slice(0, cutoff + 1).flatMap((session) => session.messages);
      const visibleIds = new Set(visible.map((message) => message.id));
      for (const id of question.gold.evidenceIds) expect(visibleIds.has(id)).toBe(true);
      for (const id of question.gold.staleFactIds) {
        const stale = facts.get(id);
        expect(stale).toBeDefined();
        expect(visibleIds.has(stale!.evidenceId)).toBe(true);
      }

      if (question.gold.expected === "answer") {
        const fact = facts.get(question.gold.factId);
        expect(fact).toBeDefined();
        expect(question.gold.evidenceIds).toContain(fact!.evidenceId);
        expect(question.gold.staleFactIds).not.toContain(fact!.id);
        expect(visible.find((message) => message.id === fact!.evidenceId)?.text).toContain(
          fact!.value,
        );
      }
    }
  }
});

it("separates recorded and effective time and gives deletion its own abstention label", () => {
  const project = buildMemoryBenchmark().projects.find((entry) => entry.id === "database")!;
  const before = project.questions.find(
    (question) => question.id === "database-before-correction",
  )!;
  const after = project.questions.find((question) => question.id === "database-after-correction")!;
  const historical = project.questions.find((question) => question.id === "database-historical")!;
  const deleted = project.questions.find((question) => question.id === "database-after-deletion")!;
  const missing = project.questions.find((question) => question.id === "database-unrecorded")!;

  expect(before.queryValidAt).toBe("2026-02-05T00:00:00.000Z");
  expect(after.queryValidAt).toBe(before.queryValidAt);
  expect(before.untilSessionId).toBe("database-proposal");
  expect(after.untilSessionId).toBe("database-correction");
  expect(before.gold).toMatchObject({ factId: "database-initial", staleFactIds: [] });
  expect(after.gold).toMatchObject({
    factId: "database-replacement",
    staleFactIds: ["database-initial"],
  });
  expect(historical.gold).toMatchObject({ factId: "database-initial", staleFactIds: [] });
  expect(deleted.gold).toEqual({
    expected: "abstain",
    evidenceIds: ["database-deletion-message"],
    staleFactIds: ["database-initial", "database-replacement"],
  });
  expect(missing.gold).toEqual({ expected: "abstain", evidenceIds: [], staleFactIds: [] });
  expect(project.facts.map((fact) => fact.value)).toEqual(["PostgreSQL", "SQLite"]);
  expect(project.sessions[1]?.messages[0]?.text).toContain("MySQL");
});

it("supplies annotations usable by the targeted metrics scorer", () => {
  const questions = buildMemoryBenchmark().projects.flatMap((project) =>
    project.questions.map(({ id, kind, gold }) => ({
      id,
      kind,
      expected: gold.expected,
      observed: gold.expected === "answer" ? "correct" : "abstain",
      staleFactIds: gold.staleFactIds,
      recalledFactIds: gold.expected === "answer" ? [gold.factId] : [],
    })),
  );
  const report = scoreMemoryMetrics({ schemaVersion: 1, writes: [], questions });
  expect(report.conflictResolutionAccuracy).toEqual({ numerator: 40, denominator: 40, value: 1 });
  expect(report.temporalAccuracy).toEqual({ numerator: 20, denominator: 20, value: 1 });
  expect(report.staleRecallRate).toEqual({ numerator: 0, denominator: 60, value: 0 });
  expect(report.abstentionAccuracy).toEqual({ numerator: 100, denominator: 100, value: 1 });
});

it("exports the same versioned JSON bytes on repeated runs", () => {
  function run() {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/export-memory-benchmark.ts"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout;
  }

  const first = run();
  expect(run()).toBe(first);
  expect(JSON.parse(first)).toEqual(buildMemoryBenchmark());
});
