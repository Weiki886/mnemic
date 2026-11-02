import { z } from "zod";

/** Existing list rules: extras stripped, status defaults in the handler, not the schema. */
export const PendingListQuerySchema = z.object({
  project_id: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "expired", "rejected", "promoted"]).optional(),
});
// JSONB may be JSON null, scalars or arrays; absent fields are never persisted values.
const json = z.unknown().refine((value) => value !== undefined, "字段不可缺失");
const id = z.string().uuid();
const time = z.string().datetime({ offset: true });
export const PendingRowSchema = z.object({
  id,
  projectId: id,
  candidate: json,
  gateScores: json,
  status: z.enum(["pending", "confirmed", "expired", "rejected", "promoted"]),
  ttlExpiresAt: time,
  evidenceId: id,
  createdAt: time,
  decidedAt: time.nullable(),
});
export const ConfirmPendingResultSchema = PendingRowSchema.extend({
  status: z.literal("confirmed"),
});
export const RejectPendingResultSchema = PendingRowSchema.extend({ status: z.literal("rejected") });
