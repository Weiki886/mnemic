import { existsSync } from "node:fs";
import { expect, it } from "vitest";
async function schemas() {
  expect(existsSync(new URL("../src/approval-audit.ts", import.meta.url))).toBe(true);
  return import("../src/approval-audit.js");
}
const id = "01920000-0000-7000-8000-000000000001";
const event = {
  event_id: id,
  request_id: id,
  project_id: id,
  session_id: id,
  mode: "confirm",
  operation: "file.create",
  decision: "allow",
  reason: "confirmed",
  scope: "once",
  root_hash: "a".repeat(64),
  target_hash: "b".repeat(64),
  target_basis: "canonical",
};
it("accepts strictly typed client reports, not arbitrary audit metadata", async () => {
  const { ApprovalAuditEventSchema: s } = await schemas();
  expect(s.parse(event)).toEqual(event);
  for (const extra of [
    { command: "secret" },
    { target: "/private" },
    { actor: "admin" },
    { meta: { value: "secret" } },
  ])
    expect(s.safeParse({ ...event, ...extra }).success).toBe(false);
});
it("rejects impossible permissions, reusable danger grants and unknown reasons", async () => {
  const { ApprovalAuditEventSchema: s } = await schemas();
  for (const change of [
    { operation: "shell", scope: "permanent", command_hash: "c".repeat(64) },
    { mode: "read-only" },
    { reason: "auto_create", operation: "file.delete", scope: undefined },
    { reason: "free text secret" },
    { decision: "deny" },
    { operation: null },
    { target_hash: null },
  ])
    expect(s.safeParse({ ...event, ...change }).success).toBe(false);
});
it("permits bounded denials without raw invalid input or invented target", async () => {
  const { ApprovalAuditEventSchema: s } = await schemas();
  expect(
    s.safeParse({
      ...event,
      decision: "deny",
      reason: "invalid_request",
      operation: null,
      scope: undefined,
      target_hash: null,
      target_basis: "none",
    }).success,
  ).toBe(true);
});
it("requires strict numeric paging and enforces bounds", async () => {
  const { ApprovalAuditQuerySchema: s } = await schemas();
  expect(s.parse({})).toEqual({ limit: 50, offset: 0 });
  expect(s.parse({ limit: "200", offset: "2" })).toEqual({ limit: 200, offset: 2 });
  for (const query of [
    { limit: 0 },
    { limit: 201 },
    { offset: -1 },
    { offset: "" },
    { offset: "1e2" },
    { raw: "secret" },
  ])
    expect(s.safeParse(query).success).toBe(false);
});
