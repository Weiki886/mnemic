import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { enqueueTask } from "../src/tasks/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
it("SIGKILL after claim leaves a durable lease; a new worker process reclaims and completes it", async () => {
  const project = uuidv7();
  await t.sql`insert into projects(id,name) values(${project},'process-worker')`;
  const { task } = await enqueueTask(t.db, {
    projectId: project,
    type: "DECAY",
    payload: {},
    idempotencyKey: uuidv7(),
  });
  const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  const children: ReturnType<typeof spawn>[] = [];
  const start = (mode: string) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path("./fixtures/task-worker-process.ts")],
      {
        cwd: path("../"),
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "",
          DASHSCOPE_API_KEY: "",
          TASK_TEST_DATABASE_URL: t.url,
          TASK_TEST_PROJECT: project,
          TASK_TEST_MODE: mode,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    const messages: { event: string; id?: string; attempts?: number; pid?: number }[] = [];
    let output = "";
    child.on("message", (m) => messages.push(m as (typeof messages)[number]));
    child.stdout!.on("data", (b: Buffer) => {
      output = (output + b.toString()).slice(-4096);
    });
    child.stderr!.on("data", (b: Buffer) => {
      output = (output + b.toString()).slice(-4096);
    });
    return { child, messages, output: () => output };
  };
  try {
    const first = start("stall");
    await vi.waitFor(
      () =>
        expect(first.messages, first.output()).toContainEqual({
          event: "ready",
          pid: first.child.pid,
        }),
      { timeout: 15000, interval: 25 },
    );
    await vi.waitFor(
      () =>
        expect(first.messages, first.output()).toContainEqual({
          event: "entered",
          id: task.id,
          attempts: 1,
        }),
      { timeout: 15000, interval: 25 },
    );
    const exited = once(first.child, "exit");
    first.child.kill("SIGKILL");
    expect((await exited)[1]).toBe("SIGKILL");
    expect((await t.sql`select status from memory_tasks where id=${task.id}`)[0]!.status).toBe(
      "running",
    );
    const second = start("record");
    await vi.waitFor(
      async () =>
        expect(
          (await t.sql`select status,attempts from memory_tasks where id=${task.id}`)[0],
          second.output(),
        ).toMatchObject({ status: "done", attempts: 2 }),
      { timeout: 15000, interval: 25 },
    );
    const effects =
      await t.sql`select meta from audit_log where actor='task-test' and target=${task.id}`;
    expect(effects).toHaveLength(1);
    expect(effects[0]!.meta).toEqual({ attempts: 2 });
    const stopped = once(second.child, "exit");
    second.child.send({ command: "stop" });
    expect((await stopped)[0]).toBe(0);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
  }
}, 40000);
