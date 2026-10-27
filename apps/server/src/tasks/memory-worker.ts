import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ResolveOptions } from "../providers/slots.js";
import { createMemoryTaskHandlers } from "./memory-handlers.js";
import { recoverExtractionTasks } from "./extraction-outbox.js";
import { TaskWorker, type WorkerOptions } from "./worker.js";
export type ExtractionQueueOptions = Pick<
  WorkerOptions,
  "projectId" | "concurrency" | "leaseMs" | "heartbeatMs" | "pollMs" | "taskTimeoutMs"
>;
export function createMemoryWorker(
  db: PostgresJsDatabase,
  key: Buffer,
  settings: ExtractionQueueOptions,
  options: ResolveOptions,
  logger: NonNullable<WorkerOptions["logger"]>,
) {
  const snapshot = { ...settings };
  let nextRecovery = 0;
  return new TaskWorker({
    db,
    ...snapshot,
    handlers: createMemoryTaskHandlers(db, key, options),
    logger,
    beforePoll: async (signal) => {
      if (performance.now() < nextRecovery) return;
      const count = await recoverExtractionTasks(db, {
        ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
        signal,
      });
      nextRecovery = performance.now() + (count === 100 ? 0 : 30000);
    },
  });
}
