import { z } from "zod";

/** #34 policy inputs only. Neither a mode nor a serialized grant is proof of human consent. */
export const ApprovalModeSchema = z.enum(["read-only", "confirm", "auto"]);
export const ApprovalScopeSchema = z.enum(["once", "session", "permanent"]);
const UUID = z.string().uuid().toLowerCase();
const Path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value));
export { Path as ApprovalPathSchema };
const FileKind = z.enum(["file.read", "file.create", "file.overwrite", "file.delete"]);
export const ApprovalOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file.read"), target: Path }).strict(),
  z.object({ kind: z.literal("file.create"), target: Path }).strict(),
  z.object({ kind: z.literal("file.overwrite"), target: Path }).strict(),
  z.object({ kind: z.literal("file.delete"), target: Path }).strict(),
  z
    .object({
      kind: z.literal("shell"),
      cwd: Path,
      command: z
        .string()
        .min(1)
        .max(16_384)
        .refine((value) => value.trim().length > 0 && !value.includes("\0")),
    })
    .strict(),
]);
const grantFields = {
  project_id: UUID,
  root: Path,
  target: Path,
  operation: z.literal("file.create"),
};
/** Dangerous operations and single-use approvals can never be loaded as reusable grants. */
export const ReusableApprovalGrantSchema = z.discriminatedUnion("scope", [
  z.object({ ...grantFields, scope: z.literal("session"), session_id: UUID }).strict(),
  z.object({ ...grantFields, scope: z.literal("permanent") }).strict(),
]);
export const ApprovalContextSchema = z
  .object({
    project_id: UUID,
    session_id: UUID,
    root: Path,
    mode: ApprovalModeSchema.default("read-only"),
    grants: z.array(ReusableApprovalGrantSchema).max(1000).default([]),
  })
  .strict();

const Target = { operation: z.union([FileKind, z.literal("shell")]), target: Path };
export const ApprovalEvaluationSchema = z
  .discriminatedUnion("decision", [
    z
      .object({
        decision: z.literal("deny"),
        reason: z.enum([
          "invalid_request",
          "invalid_root",
          "invalid_target",
          "outside_root",
          "read_only",
        ]),
      })
      .strict(),
    z
      .object({
        decision: z.literal("allow"),
        reason: z.enum(["read_allowed", "auto_create", "session_grant", "permanent_grant"]),
        ...Target,
      })
      .strict(),
    z
      .object({
        decision: z.literal("ask"),
        reason: z.literal("confirmation_required"),
        ...Target,
        allowed_scopes: z.array(ApprovalScopeSchema).min(1).max(3),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    let valid = true;
    if (value.decision === "allow")
      valid =
        value.reason === "read_allowed"
          ? value.operation === "file.read"
          : value.operation === "file.create";
    if (value.decision === "ask")
      valid =
        value.operation !== "file.read" &&
        new Set(value.allowed_scopes).size === value.allowed_scopes.length &&
        (value.operation === "file.create" ||
          (value.allowed_scopes.length === 1 && value.allowed_scopes[0] === "once"));
    if (!valid)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent approval decision" });
  });
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;
export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>;
export type ReusableApprovalGrant = z.infer<typeof ReusableApprovalGrantSchema>;
export type ApprovalContext = z.infer<typeof ApprovalContextSchema>;
export type ApprovalEvaluation = z.infer<typeof ApprovalEvaluationSchema>;
