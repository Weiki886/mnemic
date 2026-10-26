import { z } from "zod";
const id = z.string().uuid().toLowerCase();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const project = { project_id: id };
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
]);
export type DebugEvent = z.infer<typeof DebugEventSchema>;
export type DebugRecord = DebugEvent & { ts: string };
export type DebugTrace = (event: DebugEvent) => void;
export interface DebugLogger {
  debug(fields: DebugRecord, message: string): void;
}

/** Operator-owned JSONL only: strict metadata projection, no content/error passthrough or DB copy. */
export function createDebugTrace(logger?: DebugLogger): DebugTrace {
  return (input) => {
    if (!logger) return;
    try {
      const parsed = DebugEventSchema.safeParse(input);
      if (parsed.success)
        logger.debug({ ...parsed.data, ts: new Date().toISOString() }, "memory debug trace");
    } catch {
      /* Observability cannot change memory behavior or trigger paid retries. */
    }
  };
}
