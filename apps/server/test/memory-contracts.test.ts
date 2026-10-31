import { expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MemoryListQuerySchema } from "@mnemic/shared/memory";
import {
  BeliefListQuerySchema,
  BeliefParamsSchema,
  CorrectBodySchema,
  BeliefDetailSchema,
  BeliefStatusResultSchema,
  CorrectResultSchema,
  ResolutionTraceSchema,
} from "../src/contracts/memory.js";
it("server query defaults remain 200 while shared CLI default remains 20; extras are stripped", () => {
  expect(BeliefListQuerySchema.parse({ ignored: "yes" })).toEqual({
    status: "active",
    limit: 200,
    offset: 0,
  });
  expect(MemoryListQuerySchema.parse({}).limit).toBe(20);
  expect(BeliefListQuerySchema.parse({ limit: "1", offset: "2", profile: "false" })).toMatchObject({
    limit: 1,
    offset: 2,
    profile: "false",
  });
});
it.each([{ limit: "1001" }, { offset: "-1" }, { q: "x".repeat(201) }, { status: "expired" }])(
  "rejects invalid list query %j",
  (query) => {
    expect(BeliefListQuerySchema.safeParse(query).success).toBe(false);
  },
);
it("UUID params and correction preserve runtime validation and strip unknown fields", () => {
  expect(BeliefParamsSchema.safeParse({ projectId: "bad", id: uuidv7() }).success).toBe(false);
  expect(CorrectBodySchema.safeParse({ value: "" }).success).toBe(false);
  expect(CorrectBodySchema.parse({ value: "SQLite", unknown: true })).toEqual({ value: "SQLite" });
});
it("output contracts require explicit arbitrary JSON values and preserve nullable history", () => {
  const id = uuidv7(),
    at = new Date().toISOString();
  const detail = {
    id,
    project_id: uuidv7(),
    subject: "project",
    attribute: "database",
    status: "active",
    is_profile: false,
    confidence: null,
    salience: 0.5,
    importance: 0.8,
    evidence_count: 1,
    created_at: at,
    current_value: { nested: [null, 1, "SQLite"] },
    versions: [
      {
        id: uuidv7(),
        value: null,
        valid_from: at,
        valid_to: null,
        recorded_from: at,
        recorded_to: null,
        supersedes_version_id: null,
        confidence: null,
        resolver_version: null,
        source: null,
      },
    ],
  };
  expect(BeliefDetailSchema.safeParse(detail).success).toBe(true);
  const { current_value: _value, ...missing } = detail;
  expect(BeliefDetailSchema.safeParse(missing).success).toBe(false);
  expect(BeliefStatusResultSchema.safeParse({ id, status: "deleted" }).success).toBe(true);
  expect(
    CorrectResultSchema.safeParse({ beliefId: id, route: "conflict", relation: "supersede" })
      .success,
  ).toBe(true);
  expect(
    CorrectResultSchema.safeParse({ beliefId: id, route: "conflict", relation: "equal" }).success,
  ).toBe(false);
  expect(
    ResolutionTraceSchema.safeParse({
      id,
      projectId: uuidv7(),
      beliefId: id,
      observationId: uuidv7(),
      previousVersionId: null,
      resultVersionId: null,
      relation: null,
      confidenceBefore: null,
      confidenceAfter: null,
      policies: { intent: { action: "ignore" } },
      modelSnapshot: null,
      flagsSnapshot: null,
      resolverVersion: "0.2.0",
      createdAt: at,
    }).success,
  ).toBe(true);
});
