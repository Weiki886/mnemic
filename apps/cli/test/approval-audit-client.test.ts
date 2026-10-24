import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { ApprovalAuditEvent } from "../../../packages/shared/src/approval-audit.js";
async function adapter() {
  expect(existsSync(new URL("../src/approval-audit.ts", import.meta.url))).toBe(true);
  return import("../src/approval-audit.js");
}
const id = "01920000-0000-7000-8000-000000000001",
  other = "01920000-0000-7000-8000-000000000002";
const event: ApprovalAuditEvent = {
  event_id: id,
  request_id: id,
  project_id: id,
  session_id: id,
  mode: "read-only",
  operation: null,
  decision: "deny",
  reason: "invalid_request",
  root_hash: "a".repeat(64),
  target_hash: null,
  target_basis: "none",
};
const record = () => ({ event: { ...event }, recorded_at: new Date(0).toISOString() });
it("validates full ACK identity and does not retry lost responses", async () => {
  const { createApprovalAuditSink } = await adapter();
  const api = { recordApproval: vi.fn(async () => record()) };
  await createApprovalAuditSink(api, id)(event);
  api.recordApproval.mockResolvedValueOnce({ ...record(), event: { ...event, event_id: other } });
  await expect(createApprovalAuditSink(api, id)(event)).rejects.toThrow();
  api.recordApproval.mockRejectedValueOnce(new Error("response lost"));
  await expect(createApprovalAuditSink(api, id)(event)).rejects.toThrow();
  expect(api.recordApproval).toHaveBeenCalledTimes(3);
});
it("rejects a client event for another project before network", async () => {
  const { createApprovalAuditSink } = await adapter();
  const api = { recordApproval: vi.fn(async () => record()) };
  await expect(createApprovalAuditSink(api, id)({ ...event, project_id: other })).rejects.toThrow();
  expect(api.recordApproval).not.toHaveBeenCalled();
});
it("history validates project and page response instead of displaying untrusted data", async () => {
  const { runApprovalHistory } = await adapter();
  const api = {
    listApprovalAudits: vi.fn(async () => ({ items: [record()], limit: 1, offset: 0 })),
  };
  expect(await runApprovalHistory(api, id, { limit: 1, offset: 0 })).toContain(id);
  expect(api.listApprovalAudits).toHaveBeenCalledWith(id, { limit: 1, offset: 0 });
  api.listApprovalAudits.mockResolvedValueOnce({
    items: [{ ...record(), event: { ...event, project_id: other } }],
    limit: 1,
    offset: 0,
  });
  await expect(runApprovalHistory(api, id, { limit: 1, offset: 0 })).rejects.toThrow();
  api.listApprovalAudits.mockResolvedValueOnce({ items: [record()], limit: 2, offset: 0 });
  await expect(runApprovalHistory(api, id, { limit: 1, offset: 0 })).rejects.toThrow();
});
