import { DebugEventSchema, type DebugEvent, type DebugRecord } from "@mnemic/shared/debug";
export { DebugEventSchema, type DebugEvent, type DebugRecord } from "@mnemic/shared/debug";
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
