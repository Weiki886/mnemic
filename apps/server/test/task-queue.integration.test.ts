import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  enqueueTask,
  claimTasks,
  completeTask,
  retryTask,
  renewTaskLease,
  listDeadTasks,
} from "../src/tasks/repository.js";
import { migrateAgain, setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
async function seed() {
  const projectId = uuidv7(),
    conversation = uuidv7(),
    evidence = uuidv7(),
    belief = uuidv7(),
    version = uuidv7();
  await t.sql`insert into projects(id,name) values(${projectId},'tasks')`;
  await t.sql`insert into conversations(id,project_id) values(${conversation},${projectId})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${evidence},${conversation},'user','PRIVATE_TASK_SOURCE',now())`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute) values(${belief},${projectId},'task-project','database')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${version},${belief},'"PostgreSQL"',now(),now())`;
  return { projectId, evidence, version };
}
async function queued(projectId: string, options: Record<string, unknown> = {}) {
  return enqueueTask(t.db, {
    projectId,
    type: "DECAY",
    payload: {},
    idempotencyKey: uuidv7(),
    ...options,
  });
}
it("migration is repeatable, four explicit types persist references without text/secret snapshots", async () => {
  const f = await seed();
  const requests = [
    { type: "EXTRACT", payload: { evidence_id: f.evidence } },
    { type: "REEMBED", payload: { belief_version_id: f.version } },
    { type: "DECAY", payload: {} },
    { type: "COMPILE_PROFILE", payload: {} },
  ];
  for (const spec of requests) {
    const r = await enqueueTask(t.db, {
      ...spec,
      projectId: f.projectId,
      idempotencyKey: uuidv7(),
    });
    expect(r.created).toBe(true);
    expect(r.task).toMatchObject({
      type: spec.type,
      payload: spec.payload,
      status: "queued",
      attempts: 0,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  }
  await migrateAgain(t.db);
  const cols =
    await t.sql`select column_name from information_schema.columns where table_schema='public' and table_name='memory_tasks'`;
  for (const name of ["raw_text", "content", "prompt", "api_key", "response", "last_error"])
    expect(cols.map((c) => c.column_name)).not.toContain(name);
  expect(
    JSON.stringify(await t.sql`select * from memory_tasks where project_id=${f.projectId}`),
  ).not.toContain("PRIVATE_TASK_SOURCE");
});
it("concurrent enqueue deduplicates permanently and rejects conflicting identity/config without overwriting", async () => {
  const f = await seed(),
    key = uuidv7();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => queued(f.projectId, { idempotencyKey: key })),
  );
  expect(results.filter((r) => r.created)).toHaveLength(1);
  expect(new Set(results.map((r) => r.task.id)).size).toBe(1);
  const [task] = await claimTasks(t.db, { projectId: f.projectId });
  expect(await completeTask(t.db, task!)).toBe(true);
  expect((await queued(f.projectId, { idempotencyKey: key })).task.status).toBe("done");
  await expect(queued(f.projectId, { idempotencyKey: key, maxAttempts: 2 })).rejects.toThrow(
    "task identity conflict",
  );
  expect(
    (await t.sql`select count(*)::int n from memory_tasks where project_id=${f.projectId}`)[0]!.n,
  ).toBe(1);
});
it("project/type scope separates identical idempotency keys, rejects cross-project or missing payload references", async () => {
  const own = await seed(),
    other = await seed(),
    key = uuidv7();
  const a = await queued(own.projectId, { idempotencyKey: key });
  const b = await queued(other.projectId, { idempotencyKey: key });
  expect(a.task.id).not.toBe(b.task.id);
  expect(
    (await queued(own.projectId, { idempotencyKey: key, type: "COMPILE_PROFILE" })).created,
  ).toBe(true);
  for (const payload of [{ evidence_id: other.evidence }, { evidence_id: uuidv7() }])
    await expect(
      enqueueTask(t.db, {
        projectId: own.projectId,
        type: "EXTRACT",
        payload,
        idempotencyKey: uuidv7(),
      }),
    ).rejects.toThrow("invalid task scope");
  await expect(
    enqueueTask(t.db, {
      projectId: own.projectId,
      type: "REEMBED",
      payload: { belief_version_id: other.version },
      idempotencyKey: uuidv7(),
    }),
  ).rejects.toThrow("invalid task scope");
});
it("concurrent workers claim disjoint due rows, honor type filters and ignore future tasks", async () => {
  const f = await seed();
  for (let n = 0; n < 6; n++) await queued(f.projectId);
  await queued(f.projectId, { runAt: new Date(Date.now() + 3600000) });
  await queued(f.projectId, { type: "COMPILE_PROFILE" });
  const groups = await Promise.all(
    Array.from({ length: 4 }, () =>
      claimTasks(t.db, { projectId: f.projectId, types: ["DECAY"], limit: 2 }),
    ),
  );
  const claimed = groups.flat();
  expect(claimed).toHaveLength(6);
  expect(new Set(claimed.map((r) => r.id)).size).toBe(6);
  expect(
    claimed.every(
      (r) => r.status === "running" && r.attempts === 1 && r.leaseToken && r.leaseExpiresAt,
    ),
  ).toBe(true);
  expect(await claimTasks(t.db, { projectId: f.projectId, types: ["DECAY"] })).toEqual([]);
});
it("an explicit row lock is skipped rather than blocking a competing claim", async () => {
  const f = await seed(),
    a = await queued(f.projectId),
    b = await queued(f.projectId);
  await t.db.transaction(async (tx) => {
    const { sql } = await import("drizzle-orm");
    await tx.execute(sql`select id from memory_tasks where id=${a.task.id} for update`);
    const [claimed] = await claimTasks(t.db, { projectId: f.projectId, limit: 2 });
    expect(claimed!.id).toBe(b.task.id);
  });
});
it("expired leases recover through a fresh connection, replacing tokens and fencing the old worker", async () => {
  const f = await seed();
  await queued(f.projectId);
  const [old] = await claimTasks(t.db, { projectId: f.projectId });
  await t.sql`update memory_tasks set lease_expires_at=now()-interval '1 second' where id=${old!.id}`;
  const connection = postgres(t.url, { max: 1 });
  try {
    const db = drizzle(connection),
      [fresh] = await claimTasks(db, { projectId: f.projectId });
    expect(fresh!.id).toBe(old!.id);
    expect(fresh!.attempts).toBe(2);
    expect(fresh!.leaseToken).not.toBe(old!.leaseToken);
    expect(await completeTask(t.db, old!)).toBe(false);
    expect(await retryTask(t.db, old!, "HANDLER_FAILED")).toBeNull();
    expect(await renewTaskLease(t.db, old!, 10000)).toBe(false);
    expect(await completeTask(db, fresh!)).toBe(true);
  } finally {
    await connection.end();
  }
});
it("expired ownership cannot acknowledge, retry or renew even before another worker reclaims it", async () => {
  const f = await seed();
  await queued(f.projectId);
  const [task] = await claimTasks(t.db, { projectId: f.projectId });
  await t.sql`update memory_tasks set lease_expires_at=now()-interval '1 second' where id=${task!.id}`;
  expect(await completeTask(t.db, task!)).toBe(false);
  expect(await retryTask(t.db, task!, "TIMEOUT")).toBeNull();
  expect(await renewTaskLease(t.db, task!, 10000)).toBe(false);
});
it("retry uses persisted exponential delays with a cap, and the last failed attempt becomes queryable dead", async () => {
  const f = await seed();
  await queued(f.projectId, { maxAttempts: 4, backoffBaseMs: 1000, backoffCapMs: 2500 });
  for (const [n, expected] of [1000, 2000, 2500, 0].entries()) {
    const [task] = await claimTasks(t.db, { projectId: f.projectId });
    expect(task!.attempts).toBe(n + 1);
    expect(await retryTask(t.db, task!, "HANDLER_FAILED")).toBe(n === 3 ? "dead" : "failed");
    const [row] =
      await t.sql`select status,extract(epoch from(run_at-updated_at))*1000 delay,lease_token,lease_expires_at from memory_tasks where id=${task!.id}`;
    expect(row!.lease_token).toBeNull();
    expect(row!.lease_expires_at).toBeNull();
    if (expected) {
      expect(Number(row!.delay)).toBeGreaterThan(expected - 50);
      expect(Number(row!.delay)).toBeLessThan(expected + 50);
    }
    expect(await claimTasks(t.db, { projectId: f.projectId })).toEqual([]);
    if (n < 3)
      await t.sql`update memory_tasks set run_at=now()-interval '1 second' where id=${task!.id}`;
  }
  const dead = await listDeadTasks(t.db, { projectId: f.projectId });
  expect(dead).toHaveLength(1);
  expect(dead[0]).toMatchObject({ attempts: 4, status: "dead", lastErrorCode: "HANDLER_FAILED" });
  expect(await listDeadTasks(t.db, { projectId: uuidv7() })).toEqual([]);
});
it("a crashed final attempt moves to dead on the next bounded claim, without a sixth invocation", async () => {
  const f = await seed();
  await queued(f.projectId, { maxAttempts: 1 });
  const [task] = await claimTasks(t.db, { projectId: f.projectId });
  await t.sql`update memory_tasks set lease_expires_at=now()-interval '1 second' where id=${task!.id}`;
  expect(await claimTasks(t.db, { projectId: f.projectId })).toEqual([]);
  expect((await listDeadTasks(t.db, { projectId: f.projectId }))[0]).toMatchObject({
    attempts: 1,
    lastErrorCode: "LEASE_EXPIRED",
    status: "dead",
  });
});
it("heartbeats never shorten an active lease and completion is conditional and project-scoped", async () => {
  const f = await seed();
  await queued(f.projectId);
  const [task] = await claimTasks(t.db, { projectId: f.projectId, leaseMs: 60000 });
  expect(await renewTaskLease(t.db, task!, 1000)).toBe(true);
  const [row] = await t.sql`select lease_expires_at from memory_tasks where id=${task!.id}`;
  expect(new Date(row!.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
    task!.leaseExpiresAt.getTime(),
  );
  expect(await completeTask(t.db, { ...task!, projectId: uuidv7() })).toBe(false);
  expect(await completeTask(t.db, task!)).toBe(true);
  expect(await completeTask(t.db, task!)).toBe(false);
});
it("strict input validation rejects content/unknown task types and invalid budgets before storing", async () => {
  const f = await seed();
  for (const options of [
    { type: "SHELL" },
    { payload: { prompt: "SECRET" } },
    { maxAttempts: 0 },
    { maxAttempts: 101 },
    { backoffBaseMs: 0 },
    { backoffBaseMs: 20, backoffCapMs: 10 },
    { runAt: new Date(NaN) },
    { idempotencyKey: "" },
    { extra: "secret" },
  ])
    await expect(queued(f.projectId, options)).rejects.toThrow();
  const invalidClaims: NonNullable<Parameters<typeof claimTasks>[1]>[] = [
    { limit: 0 },
    { leaseMs: 0 },
    { types: [] },
    { types: ["DECAY", "DECAY"] },
  ];
  for (const options of invalidClaims) await expect(claimTasks(t.db, options)).rejects.toThrow();
  expect(await t.sql`select id from memory_tasks where project_id=${f.projectId}`).toHaveLength(0);
});
it("DDL constraints reject impossible lease, attempts and payload states, including direct SQL", async () => {
  const f = await seed(),
    r = await queued(f.projectId);
  for (const mutate of [
    () => t.sql`update memory_tasks set status='running' where id=${r.task.id}`,
    () => t.sql`update memory_tasks set attempts=-1 where id=${r.task.id}`,
    () => t.sql`update memory_tasks set attempts=101 where id=${r.task.id}`,
    () =>
      t.sql`update memory_tasks set payload='{"api_key":"SECRET"}'::jsonb where id=${r.task.id}`,
    () =>
      t.sql`update memory_tasks set last_error_code='provider secret error' where id=${r.task.id}`,
    () => t.sql`update memory_tasks set status='done' where id=${r.task.id}`,
  ])
    await expect(mutate()).rejects.toThrow();
});

it.each(["complete", "retry", "renew"] as const)(
  "%s rechecks lease time after waiting for a row lock",
  async (action) => {
    const f = await seed();
    await queued(f.projectId);
    const [task] = await claimTasks(t.db, { projectId: f.projectId, leaseMs: 1500 });
    let result: Promise<boolean | string | null> | undefined;
    try {
      await t.db.transaction(async (tx) => {
        const { sql } = await import("drizzle-orm");
        await tx.execute(sql`select id from memory_tasks where id=${task!.id} for update`);
        result =
          action === "complete"
            ? completeTask(t.db, task!)
            : action === "retry"
              ? retryTask(t.db, task!, "TIMEOUT")
              : renewTaskLease(t.db, task!, 10000);
        await vi.waitFor(
          async () => {
            const [r] =
              await t.sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%"memory_tasks"%'`;
            expect(r!.n).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        // Wait for the actual DB lease deadline, not an arbitrary scheduling sleep.
        await tx.execute(
          sql`select pg_sleep(greatest(0, extract(epoch from (lease_expires_at-clock_timestamp()))) + 0.02) from memory_tasks where id=${task!.id}`,
        );
      });
      expect(await result).toBe(action === "retry" ? null : false);
    } finally {
      await result;
    }
  },
);

it("exhausted recovery is bounded to 100 rows per claim and dead queries paginate within a project", async () => {
  const f = await seed();
  const { memoryTasks } = await import("../src/db/schema.js");
  await t.db.insert(memoryTasks).values(
    Array.from({ length: 101 }, () => ({
      id: uuidv7(),
      projectId: f.projectId,
      type: "COMPILE_PROFILE" as const,
      payload: {},
      idempotencyKey: uuidv7(),
      status: "running" as const,
      attempts: 1,
      maxAttempts: 1,
      leaseToken: uuidv7(),
      leaseExpiresAt: new Date(0),
    })),
  );
  expect(await claimTasks(t.db, { projectId: f.projectId })).toEqual([]);
  expect(await listDeadTasks(t.db, { projectId: f.projectId, limit: 1000 })).toHaveLength(100);
  expect(await claimTasks(t.db, { projectId: f.projectId })).toEqual([]);
  const first = await listDeadTasks(t.db, { projectId: f.projectId, limit: 60 });
  const second = await listDeadTasks(t.db, { projectId: f.projectId, limit: 60, offset: 60 });
  expect(first).toHaveLength(60);
  expect(second).toHaveLength(41);
  expect(new Set([...first, ...second].map((r) => r.id)).size).toBe(101);
});
