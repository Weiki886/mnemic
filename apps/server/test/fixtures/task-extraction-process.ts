import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { MockLanguageModelV2, MockEmbeddingModelV2 } from "ai/test";
import { createMemoryTaskHandlers } from "../../src/tasks/memory-handlers.js";
import { TaskWorker } from "../../src/tasks/worker.js";
import { TEST_MASTER_KEY } from "../test-keys.js";
// Isolated offline fixture. Never loads .env or uses a real model endpoint.
const client = postgres(process.env.TASK_TEST_DATABASE_URL!, { max: 4 }),
  db = drizzle(client);
const mode = process.env.TASK_TEST_MODE;
const effectsDb =
  mode === "before-commit"
    ? new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction")
            return async (work: Parameters<PostgresJsDatabase["transaction"]>[0]) =>
              target.transaction(async (tx) => {
                const result = await work(tx);
                process.send?.({ event: "effects-uncommitted" });
                await new Promise<void>(() => {});
                return result;
              });
          return Reflect.get(target, property, receiver);
        },
      })
    : db;
const real = createMemoryTaskHandlers(effectsDb, TEST_MASTER_KEY, {
  factory: {
    languageModel: () =>
      new MockLanguageModelV2({
        doGenerate: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify([
                {
                  type: "decision",
                  subject: "crash-project",
                  attribute: "database",
                  value: "PostgreSQL",
                  valid_time: "2026-10-27",
                  time_precision: "DAY",
                  time_confidence: 1,
                  assertion_intent: "ASSERT",
                  source_type: "USER_EXPLICIT",
                  importance: 0.9,
                  confidence: 0.9,
                  entities: ["crash-project"],
                  is_profile: false,
                },
              ]),
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        }),
      }),
    embeddingModel: () => new MockEmbeddingModelV2<string>(),
  },
});
const worker = new TaskWorker({
  db,
  projectId: process.env.TASK_TEST_PROJECT!,
  leaseMs: 1200,
  heartbeatMs: 200,
  pollMs: 20,
  concurrency: 1,
  handlers: {
    EXTRACT: async (task, ctx) => {
      await real.EXTRACT(task, ctx);
      if (mode === "after-commit") {
        process.send?.({ event: "effects-committed" });
        await new Promise<void>(() => {});
      }
    },
  },
});
process.on("message", (message) => {
  if ((message as { command?: string }).command !== "stop") return;
  void worker
    .stop(500)
    .then(async (r) => {
      await client.end();
      process.exit(r.drained ? 0 : 1);
    })
    .catch(() => process.exit(1));
});
worker.start();
process.send?.({ event: "ready", pid: process.pid });
