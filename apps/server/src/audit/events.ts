import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { FeatureFlagsSchema } from "@mnemic/shared/flags";
import { ApprovalAuditEventSchema } from "@mnemic/shared/approval-audit";
import { UsageTimeSchema } from "@mnemic/shared/usage";
import { writeAuditLog } from "../gate/audit.js";
const uuid = z.string().uuid().toLowerCase();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = { actor: z.literal("server") };
const version = { version: z.literal(1) };
export const PlatformEventSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        ...base,
        action: z.literal("provider.create"),
        target: uuid,
        decision: z.literal("created"),
        meta: z
          .object({
            ...version,
            protocol: z.enum(["openai-compatible", "anthropic"]),
            slots: z
              .array(z.enum(["chat", "extraction", "embedding"]))
              .max(3)
              .refine((v) => new Set(v).size === v.length),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("provider.update"),
        target: uuid,
        decision: z.literal("updated"),
        meta: z
          .object({
            ...version,
            changed_fields: z
              .array(z.enum(["name", "protocol", "base_url", "models.chat", "models.extraction"]))
              .min(1)
              .max(5)
              .refine((v) => new Set(v).size === v.length),
            before_protocol: z.enum(["openai-compatible", "anthropic"]),
            after_protocol: z.enum(["openai-compatible", "anthropic"]),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("belief.delete"),
        target: uuid,
        decision: z.literal("updated"),
        meta: z
          .object({
            ...version,
            project_id: uuid,
            before: z.literal("active"),
            after: z.literal("deleted"),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("belief.restore"),
        target: uuid,
        decision: z.literal("updated"),
        meta: z
          .object({
            ...version,
            project_id: uuid,
            before: z.literal("deleted"),
            after: z.literal("active"),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("flags.update"),
        target: z.literal("server"),
        decision: z.literal("updated"),
        meta: z
          .object({
            schema_version: z.literal(1),
            previous_revision: revision,
            revision,
            before: FeatureFlagsSchema,
            after: FeatureFlagsSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("usage.export"),
        target: uuid,
        decision: z.literal("prepared"),
        meta: z
          .object({
            ...version,
            project_id: uuid,
            conversation_id: uuid.nullable(),
            format: z.enum(["json", "csv"]),
            rows: z.number().int().min(0).max(1000),
            from: UsageTimeSchema,
            to: UsageTimeSchema,
            after: uuid.nullable(),
            next_after: uuid.nullable(),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((event, ctx) => {
    if (
      event.action === "flags.update" &&
      (event.meta.revision !== event.meta.previous_revision + 1 ||
        JSON.stringify(event.meta.before) === JSON.stringify(event.meta.after))
    )
      ctx.addIssue({ code: "custom", message: "invalid flag audit revisions" });
    if (
      event.action === "usage.export" &&
      (event.target !== event.meta.project_id ||
        Date.parse(event.meta.to) <= Date.parse(event.meta.from))
    )
      ctx.addIssue({ code: "custom", message: "invalid export audit scope" });
  });
/** Synchronous schema clone precedes any DB access; new writers cannot insert arbitrary metadata. */
export async function writePlatformAudit(db: Pick<PostgresJsDatabase, "insert">, value: unknown) {
  const event = PlatformEventSchema.parse(value);
  await writeAuditLog(db, event);
}
const Redaction = z
  .object({
    actor: z.literal("gate"),
    action: z.literal("redact"),
    target: z.union([
      uuid,
      z.enum(["candidate.value", "candidate.subject", "candidate.attribute", "candidate.entities"]),
    ]),
    decision: z.literal("redacted"),
    meta: z
      .object({
        pattern: z.enum([
          "github_pat",
          "aws_access_key",
          "openai_style_key",
          "password_assignment",
          "private_key_block",
        ]),
        count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict(),
  })
  .strict();
export function publicAuditRow(row: {
  id: string;
  ts: string;
  actor: unknown;
  action: unknown;
  target: unknown;
  decision: unknown;
  meta: unknown;
}) {
  const envelope = { id: row.id, ts: row.ts };
  const raw = {
    actor: row.actor,
    action: row.action,
    target: row.target,
    decision: row.decision,
    meta: row.meta,
  };
  const platform = PlatformEventSchema.safeParse(raw);
  if (platform.success) return { ...envelope, ...platform.data, metadata_omitted: false };
  const redaction = Redaction.safeParse(raw);
  if (redaction.success) return { ...envelope, ...redaction.data, metadata_omitted: false };
  if (row.actor === "cli" && row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)) {
    const { client_reported, version, ...value } = row.meta as Record<string, unknown>;
    const parsed = ApprovalAuditEventSchema.safeParse(value);
    if (parsed.success) {
      const e = parsed.data;
      if (
        client_reported === true &&
        version === 1 &&
        e.event_id === row.id &&
        row.action === `approval.${e.operation ?? "invalid"}` &&
        row.decision === e.decision &&
        row.target === (e.target_hash ? `sha256:${e.target_hash}` : null)
      )
        return {
          ...envelope,
          actor: "cli",
          action: row.action,
          target: row.target,
          decision: row.decision,
          meta: { ...e, client_reported: true, version: 1 },
          metadata_omitted: false,
        };
    }
  }
  // Preserve an opaque history position; never guess a future/legacy metadata contract.
  return {
    ...envelope,
    actor: null,
    action: null,
    target: null,
    decision: null,
    meta: null,
    metadata_omitted: true,
  };
}
