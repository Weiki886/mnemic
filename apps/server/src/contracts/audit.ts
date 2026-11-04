import { z } from "zod";
import { UsageTimeSchema } from "@mnemic/shared/usage";
import { ApprovalAuditEventSchema } from "@mnemic/shared/approval-audit";
import { PlatformEventSchema, RedactionEventSchema, publicAuditRow } from "../audit/events.js";

/** Existing strict input rules, shared with route and generator. */
const uuid = z.string().uuid().toLowerCase();
export const AuditQuerySchema = z
  .object({
    from: UsageTimeSchema.optional(),
    to: UsageTimeSchema.optional(),
    after: uuid.optional(),
    limit: z
      .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
      .pipe(z.number().int().min(1).max(200))
      .default(50),
    actor: z.enum(["server", "cli", "gate"]).optional(),
    action: z
      .enum([
        "provider.create",
        "provider.update",
        "flags.update",
        "belief.delete",
        "belief.restore",
        "usage.export",
        "redact",
        "approval.file.read",
        "approval.file.create",
        "approval.file.overwrite",
        "approval.file.delete",
        "approval.shell",
        "approval.invalid",
      ])
      .optional(),
    target: z
      .union([
        uuid,
        z.literal("server"),
        z.string().regex(/^sha256:[a-f0-9]{64}$/),
        z.enum([
          "candidate.value",
          "candidate.subject",
          "candidate.attribute",
          "candidate.entities",
        ]),
      ])
      .optional(),
    project_id: uuid.optional(),
  })
  .strict();

const id = z.string().uuid();
const time = z.string().datetime({ offset: true });
const envelope = { id, ts: time };
const exposed = { ...envelope, metadata_omitted: z.literal(false) };
const platform = PlatformEventSchema.innerType().options.map((event) => event.extend(exposed));
const approval = ApprovalAuditEventSchema.innerType();
const actions: [string, ...string[]] = [
  "approval.invalid",
  ...approval.shape.operation.unwrap().options.map((op) => `approval.${op}`),
];
const cli = z
  .object({
    ...exposed,
    actor: z.literal("cli"),
    action: z.enum(actions),
    target: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    decision: approval.shape.decision,
    meta: approval.extend({ client_reported: z.literal(true), version: z.literal(1) }),
  })
  .strict();
// Literal null retains enum:[null] through the OAS3 converter; z.null() becomes unconstrained.
const omitted = z
  .object({
    ...envelope,
    actor: z.literal(null),
    action: z.literal(null),
    target: z.literal(null),
    decision: z.literal(null),
    meta: z.literal(null),
    metadata_omitted: z.literal(true),
  })
  .strict();
/** Derive field shapes from existing writers; reuse projection for runtime consistency checks.
 * Only response contracts/tests consume this schema, never a new production serializer. */
export const AuditLogItemSchema = z
  .union([omitted, RedactionEventSchema.extend(exposed), cli, ...platform])
  .superRefine((row, ctx) => {
    if (!row.metadata_omitted && publicAuditRow(row).metadata_omitted)
      ctx.addIssue({ code: "custom", message: "审计响应元数据不一致" });
  });
export const AuditLogPageSchema = z
  .object({
    from: time,
    to: time,
    limit: z.number().int().min(1).max(200),
    items: z.array(AuditLogItemSchema).max(200),
    next_after: id.nullable(),
  })
  .strict();
