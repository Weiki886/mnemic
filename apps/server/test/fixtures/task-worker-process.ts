import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { TaskWorker } from "../../src/tasks/worker.js";
import { auditLog } from "../../src/db/schema.js";
// Isolated test-only process: no app startup, real credentials, provider or .env loading.
const client = postgres(process.env.TASK_TEST_DATABASE_URL!, { max: 2 });
const db = drizzle(client);
const worker = new TaskWorker({
  db,
  projectId: process.env.TASK_TEST_PROJECT!,
  concurrency: 1,
  leaseMs: 1200,
  heartbeatMs: 200,
  pollMs: 20,
  handlers: {
    DECAY: async (task, { signal }) => {
      process.send?.({ event: "entered", id: task.id, attempts: task.attempts });
      if (process.env.TASK_TEST_MODE === "stall") await new Promise<void>(() => {});
      else {
        signal.throwIfAborted();
        await db.insert(auditLog).values({
          id: uuidv7(),
          actor: "task-test",
          action: "process-recovered",
          target: task.id,
          decision: "done",
          meta: { attempts: task.attempts },
        });
      }
    },
  },
});
let stopping = false;
process.on("message", (message) => {
  if ((message as { command?: string })?.command !== "stop" || stopping) return;
  stopping = true;
  void worker
    .stop(1000)
    .then(async (result) => {
      await client.end();
      process.exit(result.drained ? 0 : 1);
    })
    .catch(() => {
      process.stderr.write("task fixture stop failed\n");
      process.exit(1);
    });
});
worker.start();
process.send?.({ event: "ready", pid: process.pid });
