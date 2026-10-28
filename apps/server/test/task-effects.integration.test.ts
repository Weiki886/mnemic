import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { claimTasks, enqueueTask, completeTaskWith } from "../src/tasks/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
async function claimed() {
  const projectId = uuidv7();
  await t.sql`insert into projects(id,name) values(${projectId},'atomic effects')`;
  await enqueueTask(t.db, { projectId, type: "DECAY", payload: {}, idempotencyKey: "effects" });
  return (await claimTasks(t.db, { projectId, leaseMs: 10000 }))[0]!;
}
it("commits effects and receipt together; repeat ownership cannot apply effects", async () => {
  const task = await claimed();
  const apply = async (tx: Parameters<Parameters<typeof completeTaskWith>[2]>[0]) => {
    await tx.execute(sql`update projects set name='applied' where id=${task.projectId}`);
    return 42;
  };
  expect(await completeTaskWith(t.db, task, apply)).toBe(42);
  await expect(completeTaskWith(t.db, task, apply)).rejects.toThrow("task lease lost");
  expect((await t.sql`select status from memory_tasks where id=${task.id}`)[0]!.status).toBe(
    "done",
  );
});
it("rolls back all effects when callback fails", async () => {
  const task = await claimed();
  await expect(
    completeTaskWith(t.db, task, async (tx) => {
      await tx.execute(sql`update projects set name='wrong' where id=${task.projectId}`);
      throw Error("injected");
    }),
  ).rejects.toThrow("injected");
  expect((await t.sql`select name from projects where id=${task.projectId}`)[0]!.name).toBe(
    "atomic effects",
  );
  expect((await t.sql`select status from memory_tasks where id=${task.id}`)[0]!.status).toBe(
    "running",
  );
});
it("expiry during work rolls back effects rather than acknowledging late", async () => {
  const task = await claimed();
  await expect(
    completeTaskWith(t.db, task, async (tx) => {
      await tx.execute(sql`update projects set name='wrong' where id=${task.projectId}`);
      await tx.execute(
        sql`update memory_tasks set lease_expires_at=clock_timestamp()-interval '1 second' where id=${task.id}`,
      );
    }),
  ).rejects.toThrow("task lease lost");
  expect((await t.sql`select name from projects where id=${task.projectId}`)[0]!.name).toBe(
    "atomic effects",
  );
});
