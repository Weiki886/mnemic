import { expect, it } from "vitest";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import {
  AuditQuerySchema,
  AuditLogItemSchema,
  AuditLogPageSchema,
} from "../src/contracts/audit.js";
import { publicAuditRow } from "../src/audit/events.js";
const id = "019abcde-0000-7000-8000-000000000001",
  other = "019abcde-0000-7000-8000-000000000002";
const ts = "2198-06-07T08:09:10.123456Z";
it("audit query preserves strict defaults, digit limits and normalized UUID filters", () => {
  expect(AuditQuerySchema.parse({})).toEqual({ limit: 50 });
  expect(
    AuditQuerySchema.parse({
      limit: "0002",
      after: id.toUpperCase(),
      target: id.toUpperCase(),
      project_id: id.toUpperCase(),
    }),
  ).toMatchObject({ limit: 2, after: id, target: id, project_id: id });
  for (const q of [
    { limit: "" },
    { limit: "1e2" },
    { limit: "1.2" },
    { limit: "201" },
    { limit: 0 },
    { unknown: "ignored?" },
    { action: "future" },
    { from: "2026-01-01T00:00:00.1234Z" },
  ])
    expect(AuditQuerySchema.safeParse(q).success).toBe(false);
});
it("response shapes accept all existing safe platform, redaction and CLI projections", () => {
  const rows = [
    {
      actor: "server",
      action: "provider.create",
      target: id,
      decision: "created",
      meta: { version: 1, protocol: "openai-compatible", slots: ["chat"] },
    },
    {
      actor: "server",
      action: "provider.update",
      target: id,
      decision: "updated",
      meta: {
        version: 1,
        changed_fields: ["name"],
        before_protocol: "openai-compatible",
        after_protocol: "anthropic",
      },
    },
    {
      actor: "server",
      action: "belief.delete",
      target: id,
      decision: "updated",
      meta: { version: 1, project_id: other, before: "active", after: "deleted" },
    },
    {
      actor: "server",
      action: "belief.restore",
      target: id,
      decision: "updated",
      meta: { version: 1, project_id: other, before: "deleted", after: "active" },
    },
    {
      actor: "server",
      action: "flags.update",
      target: "server",
      decision: "updated",
      meta: {
        schema_version: 1,
        previous_revision: 0,
        revision: 1,
        before: DEFAULT_FEATURE_FLAGS,
        after: { ...DEFAULT_FEATURE_FLAGS, memory_gate: false },
      },
    },
    {
      actor: "server",
      action: "usage.export",
      target: other,
      decision: "prepared",
      meta: {
        version: 1,
        project_id: other,
        conversation_id: null,
        format: "json",
        rows: 0,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        after: null,
        next_after: null,
      },
    },
    {
      actor: "gate",
      action: "redact",
      target: "candidate.value",
      decision: "redacted",
      meta: { pattern: "github_pat", count: 2 },
    },
    {
      actor: "cli",
      action: "approval.invalid",
      target: null,
      decision: "deny",
      meta: {
        event_id: id,
        request_id: other,
        project_id: other,
        session_id: other,
        mode: "confirm",
        operation: null,
        decision: "deny",
        reason: "invalid_request",
        root_hash: "a".repeat(64),
        target_hash: null,
        target_basis: "none",
        client_reported: true,
        version: 1,
      },
    },
  ];
  for (const raw of rows) {
    const row = publicAuditRow({ id, ts, ...raw });
    expect(row.metadata_omitted).toBe(false);
    expect(AuditLogItemSchema.safeParse(row).success).toBe(true);
  }
});
it("omitted metadata requires every field to be null, never arbitrary historical content", () => {
  const row = publicAuditRow({
    id,
    ts,
    actor: "future",
    action: "unknown",
    target: "private",
    decision: "maybe",
    meta: { secret: "private" },
  });
  expect(row).toEqual({
    id,
    ts,
    actor: null,
    action: null,
    target: null,
    decision: null,
    meta: null,
    metadata_omitted: true,
  });
  expect(AuditLogItemSchema.safeParse(row).success).toBe(true);
  expect(AuditLogItemSchema.safeParse({ ...row, meta: { secret: "private" } }).success).toBe(false);
  const { target: _target, ...missing } = row;
  expect(AuditLogItemSchema.safeParse(missing).success).toBe(false);
  expect(
    AuditLogPageSchema.safeParse({ from: ts, to: ts, limit: 201, items: [], next_after: null })
      .success,
  ).toBe(false);
});
it("exposed response metadata reuses existing envelope and cross-field consistency checks", () => {
  const row = {
    id,
    ts,
    actor: "server",
    action: "usage.export",
    target: id,
    decision: "prepared",
    meta: {
      version: 1,
      project_id: other,
      conversation_id: null,
      format: "json",
      rows: 0,
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      after: null,
      next_after: null,
    },
    metadata_omitted: false,
  };
  expect(AuditLogItemSchema.safeParse(row).success).toBe(false);
});
