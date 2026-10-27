import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import * as taskRepository from "../src/tasks/repository.js";
import { TaskWorker } from "../src/tasks/worker.js";
import { enqueueTask, claimTasks } from "../src/tasks/repository.js";
import { createPeriodicScheduler } from "../src/tasks/scheduler.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
const workers: TaskWorker[] = [],
  releases: (() => void)[] = [];
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const w of workers.splice(0)) await w.stop(1000);
});
afterAll(async () => {
  await t?.close();
});
async function project() {
  const id = uuidv7();
  await t.sql`insert into projects(id,name) values(${id},'worker')`;
  return id;
}
async function add(projectId: string, extra: Record<string, unknown> = {}) {
  return (
    await enqueueTask(t.db, {
      projectId,
      type: "DECAY",
      payload: {},
      idempotencyKey: uuidv7(),
      ...extra,
    })
  ).task;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  releases.push(release);
  return { promise, release };
}
async function state(id: string) {
  return (await t.sql`select * from memory_tasks where id=${id}`)[0]!;
}
it("serializes concurrent ticks, never exceeds per-worker concurrency, and never claims unregistered types", async () => {
  const p = await project(),
    block = gate();
  for (let n = 0; n < 5; n++) await add(p);
  const unknown = await add(p, { type: "COMPILE_PROFILE" });
  let active = 0,
    max = 0,
    calls = 0;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    concurrency: 2,
    handlers: {
      DECAY: async () => {
        calls++;
        active++;
        max = Math.max(max, active);
        try {
          await block.promise;
        } finally {
          active--;
        }
      },
    },
  });
  workers.push(w);
  await Promise.all([w.tick(), w.tick(), w.tick()]);
  await vi.waitFor(() => expect(calls).toBe(2));
  expect((await state(unknown.id)).attempts).toBe(0);
  expect(await w.tick()).toBe(0);
  block.release();
  await vi.waitFor(() => expect(active).toBe(0));
  await vi.waitFor(async () => {
    await w.tick();
    expect(
      await t.sql`select id from memory_tasks where project_id=${p} and status='done'`,
    ).toHaveLength(5);
  });
  expect(max).toBe(2);
  expect(calls).toBe(5);
});
it("heartbeats preserve ownership past the original lease deadline", async () => {
  const p = await project(),
    task = await add(p),
    block = gate();
  let entered = false;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    leaseMs: 900,
    heartbeatMs: 150,
    handlers: {
      DECAY: async () => {
        entered = true;
        await block.promise;
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(() => expect(entered).toBe(true));
  const original = await state(task.id);
  await t.db.execute(
    sql`select pg_sleep(greatest(0, extract(epoch from (${original.lease_expires_at}::timestamptz-clock_timestamp()))) + 0.05)`,
  );
  expect(await claimTasks(t.db, { projectId: p })).toEqual([]);
  expect(new Date((await state(task.id)).lease_expires_at).getTime()).toBeGreaterThan(
    new Date(original.lease_expires_at).getTime(),
  );
  block.release();
  await vi.waitFor(async () => expect((await state(task.id)).status).toBe("done"));
});
it("handler failures persist only safe codes, retry and eventually dead, never raw exceptions", async () => {
  const p = await project(),
    task = await add(p, { maxAttempts: 2, backoffBaseMs: 100, backoffCapMs: 100 });
  const logs: string[] = [];
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    logger: { warn: (s) => logs.push(s) },
    handlers: {
      DECAY: async () => {
        throw Error("sk-secretworker01234567890123456789");
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(async () => expect((await state(task.id)).status).toBe("failed"));
  await t.sql`update memory_tasks set run_at=now()-interval '1 second' where id=${task.id}`;
  await w.tick();
  await vi.waitFor(async () => expect((await state(task.id)).status).toBe("dead"));
  expect(await state(task.id)).toMatchObject({ attempts: 2, last_error_code: "HANDLER_FAILED" });
  expect(JSON.stringify(logs)).not.toContain("sk-secretworker");
  expect(logs.length).toBeGreaterThan(0);
});
it("cooperative timeout aborts and records TIMEOUT rather than success", async () => {
  const p = await project(),
    task = await add(p);
  let aborted = false;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    taskTimeoutMs: 50,
    handlers: {
      DECAY: async (_task, { signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Error("private timeout"));
            },
            { once: true },
          );
        });
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(async () => expect((await state(task.id)).status).toBe("failed"));
  expect(aborted).toBe(true);
  expect((await state(task.id)).last_error_code).toBe("TIMEOUT");
});
it("lease loss aborts the handler without completing or retrying a replacement owner's row", async () => {
  const p = await project(),
    task = await add(p),
    replacement = uuidv7();
  let entered = false,
    aborted = false;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    leaseMs: 900,
    heartbeatMs: 150,
    handlers: {
      DECAY: async (_task, { signal }) => {
        entered = true;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Error("lost"));
            },
            { once: true },
          ),
        );
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(() => expect(entered).toBe(true));
  await t.sql`update memory_tasks set lease_token=${replacement} where id=${task.id}`;
  await vi.waitFor(() => expect(aborted).toBe(true));
  expect(await state(task.id)).toMatchObject({
    status: "running",
    attempts: 1,
    lease_token: replacement,
  });
});
it("stop drains completed work, is idempotent and never starts new polls afterward", async () => {
  const p = await project(),
    task = await add(p),
    block = gate();
  let entered = false;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    pollMs: 10,
    handlers: {
      DECAY: async () => {
        entered = true;
        await block.promise;
      },
    },
  });
  workers.push(w);
  w.start();
  w.start();
  await vi.waitFor(() => expect(entered).toBe(true));
  const stopping = w.stop(1000);
  block.release();
  expect(await stopping).toEqual({ drained: true });
  expect((await state(task.id)).status).toBe("done");
  const later = await add(p);
  expect(await w.tick()).toBe(0);
  expect((await state(later.id)).status).toBe("queued");
  expect(await w.stop(0)).toEqual({ drained: true });
  expect(() => w.start()).toThrow();
});
it("deadline stop holds uncooperative work abandoned; its late completion cannot falsely acknowledge", async () => {
  const p = await project(),
    task = await add(p),
    block = gate();
  let entered = false,
    signal!: AbortSignal;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    handlers: {
      DECAY: async (_task, ctx) => {
        entered = true;
        signal = ctx.signal;
        await block.promise;
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(await w.stop(0)).toEqual({ drained: false });
  expect(signal.aborted).toBe(true);
  block.release();
  await Promise.resolve();
  await Promise.resolve();
  expect((await state(task.id)).status).toBe("running");
  expect(await w.tick()).toBe(0);
});
it("revalidates JSON references before handler execution, never trusts a persisted cross-project Evidence", async () => {
  const p = await project(),
    other = await project(),
    conversation = uuidv7(),
    evidence = uuidv7();
  await t.sql`insert into conversations(id,project_id) values(${conversation},${other})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${evidence},${conversation},'user','secret',now())`;
  const { memoryTasks } = await import("../src/db/schema.js");
  const id = uuidv7();
  await t.db.insert(memoryTasks).values({
    id,
    projectId: p,
    type: "EXTRACT",
    payload: { evidence_id: evidence },
    idempotencyKey: uuidv7(),
  });
  const handler = vi.fn(async () => {});
  const w = new TaskWorker({ db: t.db, projectId: p, handlers: { EXTRACT: handler } });
  workers.push(w);
  await w.tick();
  await vi.waitFor(async () => expect((await state(id)).status).toBe("failed"));
  expect(handler).not.toHaveBeenCalled();
});
it("snapshots handler registry and queue identity so a handler cannot redirect its acknowledgment", async () => {
  const p = await project(),
    task = await add(p),
    wrong = await add(p, { type: "COMPILE_PROFILE" });
  const handlers = {
    DECAY: async (row: { id: string; leaseToken: string }) => {
      row.id = wrong.id;
      row.leaseToken = uuidv7();
    },
  };
  const w = new TaskWorker({ db: t.db, projectId: p, handlers });
  workers.push(w);
  handlers.DECAY = async () => {
    throw Error("registry replaced");
  };
  await w.tick();
  await vi.waitFor(async () => expect((await state(task.id)).status).toBe("done"));
  expect((await state(wrong.id)).attempts).toBe(0);
});
it("independent schedulers deduplicate a stable period across restarts using DB uniqueness", async () => {
  const p = await project();
  const [clock] = await t.sql`select clock_timestamp() as now`;
  const configs = [
    {
      projectId: p,
      name: "profile",
      everyMs: 60000,
      startsAt: new Date(new Date(clock!.now).getTime() - 1000),
    },
  ];
  const schedulers = Array.from({ length: 4 }, () => createPeriodicScheduler(t.db, configs));
  expect((await Promise.all(schedulers.map((run) => run()))).reduce((a, b) => a + b, 0)).toBe(1);
  expect(await createPeriodicScheduler(t.db, configs)()).toBe(0);
  expect(await t.sql`select id from memory_tasks where project_id=${p}`).toHaveLength(1);
});
it("registered COMPILE_PROFILE handlers execute distinct real periodic buckets without duplicate execution", async () => {
  const p = await project(),
    calls: string[] = [];
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    pollMs: 10,
    schedules: [{ projectId: p, name: "profile", everyMs: 150 }],
    handlers: {
      COMPILE_PROFILE: async (row) => {
        calls.push(row.id);
      },
    },
  });
  workers.push(w);
  w.start();
  await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), {
    timeout: 5000,
    interval: 20,
  });
  expect(await w.stop(1000)).toEqual({ drained: true });
  expect(new Set(calls).size).toBe(calls.length);
  expect(
    await t.sql`select id from memory_tasks where project_id=${p} and status='done'`,
  ).toHaveLength(calls.length);
});
it("configuration fails before background work for empty handlers, unsafe budgets or unhandled schedules", async () => {
  for (const options of [
    { handlers: {} },
    { concurrency: 0 },
    { leaseMs: 99 },
    { leaseMs: 100, heartbeatMs: 50 },
    { schedules: [{ projectId: uuidv7(), name: "profile", everyMs: 100 }] },
  ])
    expect(
      () => new TaskWorker({ db: t.db, handlers: { DECAY: async () => {} }, ...options }),
    ).toThrow();
});

it("timeout does not free an uncooperative handler's slot; its late return cannot become success", async () => {
  const p = await project(),
    first = await add(p),
    second = await add(p),
    block = gate();
  let signal!: AbortSignal,
    entered = false;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    concurrency: 1,
    taskTimeoutMs: 100,
    handlers: {
      DECAY: async (_row, ctx) => {
        entered = true;
        signal = ctx.signal;
        await block.promise;
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(() => expect(entered).toBe(true));
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(await w.tick()).toBe(0);
  expect((await state(second.id)).attempts).toBe(0);
  block.release();
  await vi.waitFor(async () => expect((await state(first.id)).status).toBe("failed"));
  expect((await state(first.id)).last_error_code).toBe("TIMEOUT");
});
it("a failed heartbeat aborts conservatively without publishing success or exposing DB details", async () => {
  const p = await project(),
    task = await add(p),
    logs: string[] = [];
  let entered = false,
    aborted = false;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    leaseMs: 900,
    heartbeatMs: 150,
    logger: { warn: (s) => logs.push(s) },
    handlers: {
      DECAY: async (_row, { signal }) => {
        entered = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(() => expect(entered).toBe(true));
  const spy = vi
    .spyOn(t.db, "transaction")
    .mockRejectedValueOnce(Error("DB sk-private01234567890123456789"));
  try {
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect((await state(task.id)).status).toBe("running");
    expect(logs).toContain("task worker lease unavailable");
    expect(JSON.stringify(logs)).not.toContain("sk-private");
  } finally {
    spy.mockRestore();
  }
});

it("a broken periodic project cannot block healthy schedules, and failures are reported without payloads", async () => {
  const p = await project(),
    bad = uuidv7(),
    errors: string[] = [];
  const configs = [
    { projectId: bad, name: "bad", everyMs: 60000 },
    { projectId: p, name: "good", everyMs: 60000 },
  ];
  const run = createPeriodicScheduler(t.db, configs, () => {
    errors.push("fixed failure");
  });
  expect(await run()).toBe(1);
  expect(await t.sql`select id from memory_tasks where project_id=${p}`).toHaveLength(1);
  expect(await t.sql`select id from memory_tasks where project_id=${bad}`).toHaveLength(0);
  expect(errors).toEqual(["fixed failure"]);
});

it.each(["cpu", "microtasks"] as const)(
  "%s execution cannot outrun the deadline timer and get acknowledged as success",
  async (mode) => {
    const p = await project(),
      task = await add(p);
    let entered = false;
    const w = new TaskWorker({
      db: t.db,
      projectId: p,
      taskTimeoutMs: 100,
      leaseMs: 1000,
      heartbeatMs: 200,
      handlers: {
        DECAY: async () => {
          entered = true;
          const until = performance.now() + 160;
          while (performance.now() < until) {
            if (mode === "microtasks") await Promise.resolve();
          }
        },
      },
    });
    workers.push(w);
    await w.tick();
    await vi.waitFor(async () => expect((await state(task.id)).status).not.toBe("running"));
    expect(entered).toBe(true);
    expect(await state(task.id)).toMatchObject({ status: "failed", last_error_code: "TIMEOUT" });
  },
);

it("a handler finishing after a blocked stop deadline cannot publish a late receipt", async () => {
  const p = await project(),
    task = await add(p),
    block = gate();
  let entered = false;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    concurrency: 1,
    taskTimeoutMs: 1000,
    handlers: {
      DECAY: async () => {
        entered = true;
        await block.promise;
        const until = performance.now() + 100;
        while (performance.now() < until) {
          /* Block stop timer. */
        }
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(() => expect(entered).toBe(true));
  const receipt = vi.spyOn(taskRepository, "completeTask");
  try {
    const stopping = w.stop(10);
    block.release();
    expect(await stopping).toEqual({ drained: false });
    expect(receipt).not.toHaveBeenCalled();
    expect((await state(task.id)).status).toBe("running");
  } finally {
    receipt.mockRestore();
  }
});

it("never reclaims its own still-running timed-out handler when another concurrency slot is free", async () => {
  const p = await project(),
    first = await add(p),
    block = gate(),
    calls: string[] = [];
  let entered = false,
    signal!: AbortSignal;
  const w = new TaskWorker({
    db: t.db,
    projectId: p,
    concurrency: 2,
    leaseMs: 400,
    heartbeatMs: 100,
    taskTimeoutMs: 100,
    handlers: {
      DECAY: async (row, ctx) => {
        calls.push(row.id);
        if (row.id === first.id) {
          entered = true;
          signal = ctx.signal;
          await block.promise;
        }
      },
    },
  });
  workers.push(w);
  await w.tick();
  await vi.waitFor(() => expect(entered).toBe(true));
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  const owned = await state(first.id);
  await t.db.execute(
    sql`select pg_sleep(greatest(0, extract(epoch from (${owned.lease_expires_at}::timestamptz-clock_timestamp()))) + 0.05)`,
  );
  const next = await add(p);
  await w.tick();
  await vi.waitFor(() => expect(calls).toContain(next.id));
  expect(calls.filter((id) => id === first.id)).toHaveLength(1);
  expect((await state(first.id)).attempts).toBe(1);
  block.release();
});
