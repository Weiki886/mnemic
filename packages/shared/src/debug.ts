import { z } from "zod";
const id = z.string().uuid().toLowerCase();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const project = { project_id: id, conversation_id: id.optional() };
const event = <T extends string, S extends z.ZodRawShape>(name: T, detail: S) =>
  z.object({ event: z.literal(name), target_id: id, detail: z.object(detail).strict() }).strict();
export const DebugEventSchema = z.discriminatedUnion("event", [
  event("memory.write.failed", { ...project, phase: z.enum(["extraction", "gate", "ingest"]) }),
  event("memory.retrieval.completed", {
    ...project,
    conversation_id: id.nullable(),
    matched_count: count,
    selected_count: count,
    abstained: z.boolean(),
    reinforce_enabled: z.boolean(),
  }),
  event("memory.extraction.completed", {
    ...project,
    conversation_id: id,
    attempts: count,
    candidates_count: count,
    dropped_count: count,
    degraded: z.boolean(),
  }),
  event("memory.gate.decided", {
    ...project,
    decision: z.enum(["WRITE", "SKIP", "PENDING"]),
    pending_id: id.optional(),
  }),
  event("memory.write.completed", {
    ...project,
    route: z.enum(["created", "merged", "skipped", "conflict"]),
    observation_id: id.nullable(),
    belief_id: id.nullable(),
    relation: z.enum(["strengthen", "weaken", "extend", "supersede"]).nullable(),
  }),
  event("memory.belief.corrected", {
    ...project,
    observation_id: id.nullable(),
    route: z.enum(["created", "merged", "skipped", "conflict"]),
    relation: z.enum(["strengthen", "weaken", "extend", "supersede"]).nullable(),
  }),
  event("memory.belief.status_changed", { ...project, status: z.enum(["active", "deleted"]) }),
  event("memory.pending.decided", {
    ...project,
    evidence_id: id,
    status: z.enum(["pending", "confirmed", "expired", "rejected", "promoted"]),
  }),
]);
export type DebugEvent = z.infer<typeof DebugEventSchema>;
export type DebugRecord = DebugEvent & { ts: string };

// Captured strings can grow after redaction. This is a serialized log contract, not the raw SDK budget.
export const DEBUG_MAX_LINE_BYTES = 16 * 1024 * 1024;
const text = z.string().max(DEBUG_MAX_LINE_BYTES);
const part = z.object({ type: z.enum(["text", "reasoning"]), text }).strict();
const promptContent = z
  .array(
    z.union([
      z.object({ role: z.literal("system"), content: text }).strict(),
      z.object({ role: z.enum(["user", "assistant"]), content: z.array(part).max(2048) }).strict(),
    ]),
  )
  .max(256);
const context = {
  project_id: id,
  conversation_id: id,
  evidence_id: id,
  provider_name: z.string().max(4096),
  model_id: z.string().max(4096),
  slot: z.enum(["chat", "extraction"]),
};
const reason = z.enum(["size_limit", "unsupported", "cross_boundary_secret", "incomplete"]);
function payload<T extends z.ZodTypeAny>(content: T, response: boolean) {
  const fields = {
    ...context,
    ...(response ? { status: z.enum(["success", "error", "aborted"]) } : {}),
  };
  return z.discriminatedUnion("complete", [
    z.object({ ...fields, complete: z.literal(true), omitted_reason: z.null(), content }).strict(),
    z
      .object({ ...fields, complete: z.literal(false), omitted_reason: reason, content: z.null() })
      .strict(),
  ]);
}
const timestamp = z.string().datetime({ offset: true });
const ModelRecord = z.discriminatedUnion("event", [
  z
    .object({
      ts: timestamp,
      event: z.literal("model.prompt"),
      target_id: id,
      detail: payload(promptContent, false),
    })
    .strict(),
  z
    .object({
      ts: timestamp,
      event: z.literal("model.response"),
      target_id: id,
      detail: payload(z.array(part).max(2048), true),
    })
    .strict(),
]);
export const ModelContentRecordSchema = ModelRecord.superRefine((record, ctx) => {
  if (
    record.event === "model.response" &&
    record.detail.complete &&
    record.detail.status !== "success"
  )
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent response" });
  if (record.event === "model.prompt" && record.detail.complete) {
    const parts = record.detail.content.reduce(
      (n, m) => n + (Array.isArray(m.content) ? m.content.length : 0),
      0,
    );
    if (parts > 2048) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "too many parts" });
  }
});
export type ParsedModelContentRecord = z.infer<typeof ModelContentRecordSchema>;
export type DebugLogRecord = DebugRecord | ParsedModelContentRecord;

/** Pino envelope is not trusted data: project only the known record, discard raw errors/headers. */
export function parseDebugLine(line: string): DebugLogRecord | null {
  try {
    if (
      line.length > DEBUG_MAX_LINE_BYTES ||
      new TextEncoder().encode(line).length > DEBUG_MAX_LINE_BYTES
    )
      return null;
    const raw: unknown = JSON.parse(line);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const input = { event: value.event, target_id: value.target_id, detail: value.detail };
    const ts = timestamp.safeParse(value.ts);
    if (!ts.success) return null;
    if (value.msg === "memory debug trace") {
      const parsed = DebugEventSchema.safeParse(input);
      return parsed.success ? { ...parsed.data, ts: ts.data } : null;
    }
    if (value.msg === "model debug content") {
      const parsed = ModelContentRecordSchema.safeParse({ ...input, ts: ts.data });
      return parsed.success ? parsed.data : null;
    }
    return null;
  } catch {
    return null;
  }
}
export const DebugSelectionSchema = z
  .object({
    project_id: id,
    conversation_id: id.optional(),
    target_id: id.optional(),
    include_content: z.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(1000).default(50),
  })
  .strict();
export type DebugSelection = z.infer<typeof DebugSelectionSchema>;
