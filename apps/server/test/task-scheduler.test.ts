import { expect, it, vi } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { planPeriodicTasks, createPeriodicScheduler } from "../src/tasks/scheduler.js";
const projectId = "11111111-1111-4111-8111-111111111111";
const schedule = {
  projectId,
  name: "profile",
  everyMs: 1000,
  startsAt: new Date("2026-01-01T00:00:00Z"),
};
it("plans stable UTC bucket identities, produces the next bucket once and skips pre-start time", () => {
  const a = planPeriodicTasks([schedule], new Date("2026-01-01T00:00:00.100Z"));
  const b = planPeriodicTasks([schedule], new Date("2026-01-01T00:00:00.999Z"));
  const c = planPeriodicTasks([schedule], new Date("2026-01-01T00:00:01.000Z"));
  expect(a).toEqual(b);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({
    projectId,
    type: "COMPILE_PROFILE",
    payload: {},
    runAt: schedule.startsAt,
  });
  expect(c[0]!.idempotencyKey).not.toBe(a[0]!.idempotencyKey);
  expect(c[0]!.runAt.toISOString()).toBe("2026-01-01T00:00:01.000Z");
  expect(planPeriodicTasks([schedule], new Date("2025-12-31T23:59:59Z"))).toEqual([]);
});
it("long downtime coalesces to the current bucket instead of backfilling unbounded history", () => {
  const plans = planPeriodicTasks([schedule], new Date("2026-10-27T00:00:00Z"));
  expect(plans).toHaveLength(1);
  expect(plans[0]!.runAt.toISOString()).toBe("2026-10-27T00:00:00.000Z");
});
it("separates project/name/configuration identities and never depends on local timezone", () => {
  const now = new Date("2026-01-01T08:00:00+08:00");
  const rows = planPeriodicTasks(
    [
      schedule,
      { ...schedule, name: "other" },
      { ...schedule, projectId: "22222222-2222-4222-8222-222222222222" },
    ],
    now,
  );
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => `${r.projectId}:${r.idempotencyKey}`)).size).toBe(3);
  expect(rows[0]!.idempotencyKey).not.toBe(
    planPeriodicTasks([{ ...schedule, everyMs: 2000 }], now)[0]!.idempotencyKey,
  );
});
it.each(
  [
    [{ ...schedule, everyMs: 0 }],
    [{ ...schedule, everyMs: 1.5 }],
    [{ ...schedule, name: "bad/key" }],
    [{ ...schedule, startsAt: new Date(NaN) }],
    [{ ...schedule, startsAt: new Date(-1) }],
    [schedule, schedule],
    Array.from({ length: 101 }, (_, i) => ({ ...schedule, name: `p${i}` })),
    [{ ...schedule, payload: { api_key: "secret" } }],
  ].map((configs) => ({ configs })),
)("rejects invalid or duplicate schedule configuration", ({ configs }) => {
  expect(() => planPeriodicTasks(configs, new Date())).toThrow();
});
it("empty schedules do not inspect a DB connection or environment", async () => {
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      throw Error("must stay offline");
    },
  });
  expect(await createPeriodicScheduler(db, [])()).toBe(0);
});

it("stop during the DB clock read prevents enqueueing any new period", async () => {
  const abort = new AbortController();
  let release!: (rows: unknown[]) => void;
  const clock = new Promise<unknown[]>((r) => {
    release = r;
  });
  const transaction = vi.fn(async () => {
    throw Error("enqueue must not start");
  });
  const db = { execute: () => clock, transaction } as unknown as PostgresJsDatabase;
  const run = createPeriodicScheduler(db, [schedule]);
  const pending = run(abort.signal);
  abort.abort();
  release([{ now: new Date("2026-01-01T00:00:01Z") }]);
  expect(await pending).toBe(0);
  expect(transaction).not.toHaveBeenCalled();
});
it("stop between scheduled enqueues prevents the remaining configurations from producing work", async () => {
  const abort = new AbortController();
  const transaction = vi.fn(async () => {
    abort.abort();
    return { created: true, task: {} };
  });
  const db = {
    execute: async () => [{ now: new Date("2026-01-01T00:00:01Z") }],
    transaction,
  } as unknown as PostgresJsDatabase;
  const run = createPeriodicScheduler(db, [schedule, { ...schedule, name: "second" }]);
  expect(await run(abort.signal)).toBe(1);
  expect(transaction).toHaveBeenCalledOnce();
});
