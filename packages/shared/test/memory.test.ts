import { describe, expect, it } from "vitest";
import * as shared from "../src/index.js";

const id = "01920000-0000-7000-8000-000000000001";
const row = {
  id,
  subject: "project",
  attribute: "database",
  type: "decision",
  status: "active",
  is_profile: false,
  confidence: 0.9,
  salience: 0,
  importance: null,
  evidence_count: 1,
  created_at: "2026-10-21T00:00:00Z",
  current_value: "PostgreSQL",
};

describe("memory HTTP contracts (#32)", () => {
  it("exports one canonical list item schema with current source type and numeric scores", () => {
    expect(shared.BeliefListItemSchema).toBeDefined();
    expect(shared.BeliefListSchema.element).toBe(shared.BeliefListItemSchema);
    expect(shared.BeliefListItemSchema.parse(row)).toEqual(row);
    expect(shared.BeliefListItemSchema.parse({ ...row, type: null }).type).toBeNull();
  });

  it.each([
    { ...row, type: undefined },
    { ...row, type: "procedural" },
    { ...row, confidence: "0.900" },
    { ...row, id: "bad" },
    { ...row, current_value: undefined },
    { ...row, evidence_count: -1 },
  ])("rejects incompatible row %#", (value) => {
    expect(shared.BeliefListItemSchema).toBeDefined();
    expect(shared.BeliefListItemSchema.safeParse(value).success).toBe(false);
  });

  it("query defaults match CLI pagination and accepts optional source type", () => {
    expect(shared.MemoryListQuerySchema).toBeDefined();
    expect(shared.MemoryListQuerySchema.parse({})).toEqual({
      status: "active",
      limit: 20,
      offset: 0,
    });
    expect(
      shared.MemoryListQuerySchema.parse({ type: "preference", limit: "5", offset: "10", q: "db" }),
    ).toMatchObject({ type: "preference", limit: 5, offset: 10, q: "db" });
  });

  it.each([
    { type: "other" },
    { limit: 0 },
    { limit: 1001 },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { q: "x".repeat(201) },
  ])("rejects invalid list query %#", (query) => {
    expect(shared.MemoryListQuerySchema).toBeDefined();
    expect(shared.MemoryListQuerySchema.safeParse(query).success).toBe(false);
  });

  it("forget confirmation only accepts UUID and deleted status", () => {
    expect(shared.ForgetResultSchema).toBeDefined();
    expect(shared.ForgetResultSchema.parse({ id: id.toUpperCase(), status: "deleted" })).toEqual({
      id,
      status: "deleted",
    });
    expect(shared.ForgetResultSchema.safeParse({ id, status: "active" }).success).toBe(false);
  });
});
