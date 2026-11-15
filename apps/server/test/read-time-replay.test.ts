import { expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { replayObservationGroup } from "../src/retrieval/read-time-replay.js";

const projectId = uuidv7();
const group = { projectId, subject: "app", attribute: "database" };
function event(overrides: Record<string, unknown> = {}) {
  return {
    ...group,
    id: uuidv7(),
    evidenceId: uuidv7(),
    value: "PostgreSQL",
    authority: 60,
    assertionIntent: "ASSERT",
    sourceType: "USER_EXPLICIT",
    validTime: new Date("2025-01-01Z"),
    recordedAt: new Date("2025-01-02Z"),
    ...overrides,
  };
}
const run = (observations: unknown[], authorityEnabled = true) =>
  replayObservationGroup({ group, observations, authorityEnabled });

it("bootstraps ASSERT from real Observation and Evidence references without inventing a version", () => {
  const a = event();
  const result = run([a]);
  expect(result.selected).toEqual({
    observationId: a.id,
    evidenceId: a.evidenceId,
    value: "PostgreSQL",
    validFrom: a.validTime,
  });
  expect(result.decisions).toEqual([
    {
      observationId: a.id,
      action: "create",
      relation: null,
      reason: null,
      previousObservationId: null,
      resultObservationId: a.id,
    },
  ]);
  expect(result).not.toHaveProperty("beliefVersionId");
});
it.each([
  [{ value: "postgresql" }, "strengthen", "PostgreSQL"],
  [{ value: "PostgreSQL 17" }, "extend", "PostgreSQL 17"],
  [{ value: "SQLite", assertionIntent: "UPDATE", authority: 70 }, "supersede", "SQLite"],
  [{ value: "SQLite", assertionIntent: "UPDATE", authority: 10 }, "weaken", "PostgreSQL"],
] as const)("reuses four-state decision %j", (change, relation, value) => {
  const result = run([event(), event(change)]);
  expect(result.decisions[1]?.relation).toBe(relation);
  expect(result.selected?.value).toBe(value);
});
it("ordinary conflicting ASSERT cannot replace a manual correction", () => {
  const result = run([
    event({ sourceType: "USER_CORRECTION", authority: 70 }),
    event({ value: "SQLite" }),
  ]);
  expect(result.selected?.value).toBe("PostgreSQL");
  expect(result.decisions[1]?.action).toBe("ignore");
});
it("disabling authority skips only authority dominance, not intent protection", () => {
  const later = event({
    value: "SQLite",
    assertionIntent: "UPDATE",
    authority: 10,
    validTime: new Date("2025-02-01Z"),
  });
  expect(run([event(), later], false).selected?.value).toBe("SQLite");
  expect(run([event(), { ...later, assertionIntent: "ASSERT" }], false).selected?.value).toBe(
    "PostgreSQL",
  );
});
it("late evidence weakens and equal-time UPDATE supersedes", () => {
  const a = event();
  expect(
    run([
      a,
      event({ value: "SQLite", assertionIntent: "UPDATE", validTime: new Date("2024-01-01Z") }),
    ]).decisions[1]?.reason,
  ).toBe("late_evidence");
  expect(run([a, event({ value: "SQLite", assertionIntent: "UPDATE" })]).selected?.value).toBe(
    "SQLite",
  );
});
it("validTime null falls back to the Observation's recordedAt", () => {
  const a = event({ validTime: null });
  expect(run([a]).selected?.validFrom).toEqual(a.recordedAt);
});
it("user RETRACT clears local selection, ASSERT stays ignored, explicit correction recreates it", () => {
  const events = [event(), event({ assertionIntent: "RETRACT" })];
  expect(run(events).selected).toBeNull();
  expect(run([...events, event()]).selected).toBeNull();
  const restored = run([...events, event({ value: "SQLite", assertionIntent: "CORRECT" })]);
  expect(restored.selected?.value).toBe("SQLite");
  expect(restored.decisions.at(-1)?.relation).toBe("supersede");
});
it("agent RETRACT is ignored even before the first fact", () => {
  const a = event({ assertionIntent: "RETRACT", sourceType: "AGENT_INFERENCE", authority: 10 });
  expect(run([a]).selected).toBeNull();
  expect(run([a, event()]).selected?.value).toBe("PostgreSQL");
});
it("does not mutate inputs; returned value and dates do not alias the caller", () => {
  const a = event({ value: { driver: ["pg"] } });
  const before = structuredClone(a);
  const result = run([a]);
  expect(a).toEqual(before);
  (result.selected!.value as { driver: string[] }).driver.push("modified");
  result.selected!.validFrom.setUTCFullYear(2000);
  expect(a).toEqual(before);
  expect(JSON.stringify(result.decisions)).not.toContain("driver");
});
it("accepts historical arbitrary JSONB values including null", () => {
  expect(run([event({ value: null })]).selected?.value).toBeNull();
  expect(run([event({ value: [1, true, { a: "b" }] })]).selected?.value).toEqual([
    1,
    true,
    { a: "b" },
  ]);
});
it.each([
  () => [],
  () => Array.from({ length: 201 }, () => event()),
  () => [event({ projectId: uuidv7() })],
  () => [event({ attribute: "secret" })],
  () => [event({ subject: "other" })],
  () => [event({ id: "private-sentinel" })],
  () => [event({ value: "x".repeat(16385) })],
  () => Array.from({ length: 5 }, () => event({ value: "x".repeat(16000) })),
  () => [event({ value: undefined })],
  () => [event({ value: NaN })],
  () => {
    let value: unknown = "private-sentinel";
    for (let i = 0; i < 34; i++) value = [value];
    return [event({ value })];
  },
  () => [event({ sourceType: "invented" })],
  () => [event({ assertionIntent: "invented" })],
  () => [event({ validTime: new Date(NaN) })],
  () => [event({ recordedAt: new Date("2026-01-01Z") }), event()],
  () => {
    const a = event();
    return [a, a];
  },
  () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    return [event({ value: a })];
  },
])("invalid or incomplete history fails as a whole without input echo %j", (make) => {
  expect(() => run(make())).toThrow("INVALID_READ_TIME_REPLAY");
});
