import { expect, it, vi } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TaskWorker } from "../src/tasks/worker.js";
it("background database and logger failures are isolated, without unhandled rejection or raw exception output", async () => {
  const calls: string[] = [];
  const db = {
    transaction: async () => {
      throw Error("sk-privateworker01234567890123456789");
    },
  } as unknown as PostgresJsDatabase;
  const w = new TaskWorker({
    db,
    pollMs: 10,
    handlers: { DECAY: async () => {} },
    logger: {
      warn: (s) => {
        calls.push(s);
        throw Error("logger secret");
      },
    },
  });
  w.start();
  try {
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(1));
  } finally {
    expect(await w.stop(1000)).toEqual({ drained: true });
  }
  expect(calls.every((s) => s === "task worker poll failed")).toBe(true);
});
it("a claim finishing after the stop deadline never starts a new handler", async () => {
  let release!: (rows: unknown[]) => void;
  const pending = new Promise<unknown[]>((r) => {
    release = r;
  });
  const db = { transaction: () => pending } as unknown as PostgresJsDatabase,
    handler = vi.fn(async () => {});
  const w = new TaskWorker({ db, handlers: { DECAY: handler } });
  const tick = w.tick();
  await Promise.resolve();
  await Promise.resolve();
  expect(await w.stop(0)).toEqual({ drained: false });
  release([
    {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      type: "DECAY",
      payload: {},
      leaseToken: "33333333-3333-4333-8333-333333333333",
    },
  ]);
  expect(await tick).toBe(0);
  expect(handler).not.toHaveBeenCalled();
});
it("periodic schedules require an own registered handler, not an inherited prototype property", () => {
  const handlers = Object.setPrototypeOf(
    { DECAY: async () => {} },
    { COMPILE_PROFILE: async () => {} },
  );
  expect(
    () =>
      new TaskWorker({
        db: {} as PostgresJsDatabase,
        handlers,
        schedules: [
          { projectId: "11111111-1111-4111-8111-111111111111", name: "profile", everyMs: 1000 },
        ],
      }),
  ).toThrow("unhandled task schedule");
});
