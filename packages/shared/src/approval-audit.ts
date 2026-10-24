import { z } from "zod";
import { ApprovalModeSchema, ApprovalScopeSchema } from "./approval.js";
const uuid = z.string().uuid().toLowerCase();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const allowReasons = [
  "read_allowed",
  "auto_create",
  "session_grant",
  "permanent_grant",
  "confirmed",
] as const;
export const ApprovalAuditEventSchema = z
  .object({
    event_id: uuid,
    request_id: uuid,
    project_id: uuid,
    session_id: uuid,
    mode: ApprovalModeSchema,
    operation: z
      .enum(["file.read", "file.create", "file.overwrite", "file.delete", "shell"])
      .nullable(),
    decision: z.enum(["allow", "deny"]),
    reason: z.enum([
      ...allowReasons,
      "invalid_request",
      "invalid_root",
      "invalid_target",
      "outside_root",
      "read_only",
      "closed",
      "busy",
      "cancelled",
      "denied",
      "changed",
      "storage_error",
    ]),
    scope: ApprovalScopeSchema.optional(),
    root_hash: hash,
    target_hash: hash.nullable(),
    target_basis: z.enum(["canonical", "requested", "none"]),
    command_hash: hash.optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    let valid =
      (e.target_basis === "none") === (e.target_hash === null) &&
      (e.operation === "shell") === (e.command_hash !== undefined);
    if (e.decision === "deny")
      valid &&= !allowReasons.some((r) => r === e.reason) && e.scope === undefined;
    else {
      valid &&= e.operation !== null && e.target_hash !== null && e.target_basis === "canonical";
      if (e.reason === "confirmed")
        valid &&=
          e.mode !== "read-only" &&
          e.operation !== "file.read" &&
          e.scope !== undefined &&
          (e.operation === "file.create" || e.scope === "once");
      else if (e.reason === "read_allowed")
        valid &&= e.operation === "file.read" && e.scope === undefined;
      else
        valid &&=
          e.operation === "file.create" &&
          e.scope === undefined &&
          (e.reason === "auto_create"
            ? e.mode === "auto"
            : (e.reason === "session_grant" || e.reason === "permanent_grant") &&
              e.mode === "confirm");
    }
    if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "审批审计字段不一致" });
  });
function integer(min: number, max: number) {
  return z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .refine((v) => Number.isSafeInteger(v) && v >= min && v <= max);
}
export const ApprovalAuditQuerySchema = z
  .object({
    limit: integer(1, 200).default(50),
    offset: integer(0, Number.MAX_SAFE_INTEGER).default(0),
  })
  .strict();
export const ApprovalAuditRecordSchema = z
  .object({ event: ApprovalAuditEventSchema, recorded_at: z.string().datetime({ offset: true }) })
  .strict();
export const ApprovalAuditPageSchema = z
  .object({
    items: z.array(ApprovalAuditRecordSchema).max(200),
    limit: z.number().int().min(1).max(200),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ApprovalAuditEvent = z.infer<typeof ApprovalAuditEventSchema>;
export type ApprovalAuditRecord = z.infer<typeof ApprovalAuditRecordSchema>;
export type ApprovalAuditPage = z.infer<typeof ApprovalAuditPageSchema>;
export type ApprovalAuditQuery = z.infer<typeof ApprovalAuditQuerySchema>;
export type ApprovalAuditSink = (event: ApprovalAuditEvent) => Promise<void>;
