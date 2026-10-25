import { expect, it, vi } from "vitest";
import { createApiClient } from "../src/api.js";
import type { ApprovalAuditEvent } from "../src/approval-audit.js";
const id = "01920000-0000-7000-8000-000000000001";
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
it("posts bounded audit requests with auth and queries only the project page", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ event, recorded_at: new Date(0).toISOString() })),
  );
  const api = createApiClient({
    baseUrl: "http://local",
    token: "test-token",
    timeoutMs: 120_000,
    fetch,
  });
  try {
    await api.recordApproval(id, event);
    expect(fetch.mock.calls[0]![0]).toBe(`http://local/projects/${id}/approvals`);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(event);
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(timeout).toHaveBeenCalledWith(5000);
    await api.listApprovalAudits(id, { limit: 20, offset: 40 });
    expect(fetch.mock.calls[1]![0]).toBe(
      `http://local/projects/${id}/approvals?limit=20&offset=40`,
    );
  } finally {
    timeout.mockRestore();
  }
});
