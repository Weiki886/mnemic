import { expect, it } from "vitest";
import {
  PendingListQuerySchema,
  PendingRowSchema,
  ConfirmPendingResultSchema,
  RejectPendingResultSchema,
} from "../src/contracts/pending.js";
const id = "01900000-0000-7000-8000-000000000001";
const row = {
  id,
  projectId: id,
  evidenceId: id,
  candidate: null,
  gateScores: null,
  status: "pending",
  ttlExpiresAt: "2026-11-03T00:00:00Z",
  createdAt: "2026-11-02T00:00:00Z",
  decidedAt: null,
};
it("list preserves required UUID, optional status and stripping rather than strict extras", () => {
  expect(PendingListQuerySchema.parse({ project_id: id, extra: "ignored" })).toEqual({
    project_id: id,
  });
  for (const input of [{}, { project_id: "bad" }, { project_id: id, status: "active" }])
    expect(PendingListQuerySchema.safeParse(input).success).toBe(false);
  for (const status of ["pending", "confirmed", "expired", "rejected", "promoted"])
    expect(PendingListQuerySchema.parse({ project_id: id, status }).status).toBe(status);
});
it("stored JSONB payloads are required but retain arbitrary historical JSON including null", () => {
  for (const value of [null, false, 0, "stored", [], { nested: [null] }])
    expect(
      PendingRowSchema.safeParse({ ...row, candidate: value, gateScores: value }).success,
    ).toBe(true);
  const { candidate: _c, ...missingCandidate } = row;
  const { gateScores: _g, ...missingScores } = row;
  expect(PendingRowSchema.safeParse(missingCandidate).success).toBe(false);
  expect(PendingRowSchema.safeParse(missingScores).success).toBe(false);
});
it("decision output contracts constrain the returned action status without constraining old JSONB", () => {
  expect(
    ConfirmPendingResultSchema.safeParse({ ...row, status: "confirmed", decidedAt: row.createdAt })
      .success,
  ).toBe(true);
  expect(
    RejectPendingResultSchema.safeParse({ ...row, status: "rejected", decidedAt: row.createdAt })
      .success,
  ).toBe(true);
  expect(ConfirmPendingResultSchema.safeParse({ ...row, status: "rejected" }).success).toBe(false);
  expect(RejectPendingResultSchema.safeParse({ ...row, status: "confirmed" }).success).toBe(false);
});
