import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { TaskWorker } from "../src/tasks/worker.js";
import { enqueueTask } from "../src/tasks/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
it("handler checkpoint rejects deadline even when CPU work prevents abort timers", async () => {
  const p = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'checkpoint')`;
  await enqueueTask(t.db, {
    projectId: p,
    type: "DECAY",
    payload: {},
    idempotencyKey: "checkpoint",
  });
  let checkpoint: unknown, error: unknown;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    taskTimeoutMs: 20,
    handlers: {
      DECAY: async (_, ctx) => {
        checkpoint = ctx.checkpoint;
        const until = performance.now() + 40;
        while (performance.now() < until) {
          /* Intentionally starve timers. */
        }
        try {
          ctx.checkpoint();
        } catch (e) {
          error = e;
          throw e;
        }
      },
    },
  });
  await w.tick();
  await vi.waitFor(() => expect(error).toBeInstanceOf(DOMException));
  expect(checkpoint).toBeTypeOf("function");
  await w.stop();
});
it("trusted beforePoll recovery completes before any task is claimed", async () => {
  const p = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'before poll')`;
  const beforePoll = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    await enqueueTask(t.db, { projectId: p, type: "DECAY", payload: {}, idempotencyKey: "before" });
  });
  const handler = vi.fn(async () => {});
  const w = new TaskWorker({ db: t.db, projectId: p, beforePoll, handlers: { DECAY: handler } });
  expect(await w.tick()).toBe(1);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  await w.stop();
  expect(beforePoll).toHaveBeenCalledOnce();
});
