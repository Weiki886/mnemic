import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { enqueueExtraction } from "../src/tasks/extraction-outbox.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "crash-extract",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { extraction: "extract" },
  });
}, 180000);
afterAll(async () => {
  await t?.close();
});
it.each(["before-commit", "after-commit"])(
  "SIGKILL %s recovers one set of memory effects and its atomic receipt",
  async (mode) => {
    const projectId = uuidv7(),
      conversationId = uuidv7(),
      id = uuidv7();
    await t.sql`insert into projects(id,name) values(${projectId},'crash test')`;
    await t.sql`insert into conversations(id,project_id) values(${conversationId},${projectId})`;
    await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${id},${conversationId},'user','database decision',now())`;
    const { task } = await enqueueExtraction(t.db, projectId, id);
    const children: ReturnType<typeof spawn>[] = [];
    const start = (mode: string) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./fixtures/task-extraction-process.ts", import.meta.url)),
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: {
            ...process.env,
            DEEPSEEK_API_KEY: "",
            DASHSCOPE_API_KEY: "",
            TASK_TEST_DATABASE_URL: t.url,
            TASK_TEST_PROJECT: projectId,
            TASK_TEST_MODE: mode,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      const events: unknown[] = [];
      let output = "";
      child.on("message", (m) => events.push(m));
      child.stderr!.on("data", (b) => {
        output = (output + b.toString()).slice(-3000);
      });
      return { child, events, output: () => output };
    };
    try {
      const first = start(mode);
      await vi.waitFor(
        () =>
          expect(first.events, first.output()).toContainEqual({
            event: "ready",
            pid: first.child.pid,
          }),
        { timeout: 15000 },
      );
      await vi.waitFor(
        () =>
          expect(first.events, first.output()).toContainEqual({
            event: mode === "before-commit" ? "effects-uncommitted" : "effects-committed",
          }),
        { timeout: 15000 },
      );
      const expectedBefore = mode === "before-commit" ? 0 : 1;
      expect(await t.sql`select * from observations where evidence_id=${id}`).toHaveLength(
        expectedBefore,
      );
      const exit = once(first.child, "exit");
      first.child.kill("SIGKILL");
      expect((await exit)[1]).toBe("SIGKILL");
      const second = start("recover");
      await vi.waitFor(
        async () =>
          expect(
            (await t.sql`select status,attempts from memory_tasks where id=${task.id}`)[0],
            second.output(),
          ).toMatchObject({ status: "done", attempts: mode === "before-commit" ? 2 : 1 }),
        { timeout: 15000, interval: 25 },
      );
      await vi.waitFor(
        () =>
          expect(second.events, second.output()).toContainEqual({
            event: "ready",
            pid: second.child.pid,
          }),
        { timeout: 15000 },
      );
      expect(await t.sql`select * from observations where evidence_id=${id}`).toHaveLength(1);
      expect(
        (await t.sql`select evidence_count from beliefs where project_id=${projectId}`)[0]!
          .evidence_count,
      ).toBe(1);
      expect(
        await t.sql`select * from memory_tasks where project_id=${projectId} and type='REEMBED'`,
      ).toHaveLength(1);
      expect(
        await t.sql`select * from model_usage where project_id=${projectId} and purpose='extraction'`,
      ).toHaveLength(mode === "before-commit" ? 2 : 1);
      const stopped = once(second.child, "exit");
      second.child.send({ command: "stop" });
      expect((await stopped)[0]).toBe(0);
    } finally {
      await Promise.all(
        children.map(async (c) => {
          if (c.exitCode !== null || c.signalCode !== null) return;
          const exit = once(c, "exit");
          c.kill("SIGKILL");
          await exit;
        }),
      );
    }
  },
  30000,
);
