import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { durableModels } from "./fixtures/durable-models.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
it.each(["JSON", "SSE"])(
  "managed real worker drains %s admission through extraction and eventual indexing",
  async (transport) => {
    const projectId = uuidv7();
    await t.sql`insert into projects(id,name) values(${projectId},'durable HTTP')`;
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "durable-http",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "offline",
      models: { chat: "chat", extraction: "extract", embedding: "embed" },
    });
    const m = durableModels();
    const app = buildApp({
      auth: false,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      providerFactory: m.factory,
      extractionQueue: { projectId, pollMs: 10 },
      logStream: { write: () => {} },
      chatDeps: {
        retrieveFn: async () => ({ candidates: [], abstained: true, traceId: uuidv7() }),
      },
    });
    try {
      const create = await app.inject({
        method: "POST",
        url: "/v1/conversations",
        payload: { project_id: projectId },
      });
      expect(create.statusCode).toBe(200);
      const id = create.json().id;
      const result = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/conversations/${id}/messages${transport === "SSE" ? "/stream" : ""}`,
        payload: { text: "database is PostgreSQL" },
      });
      expect(result.statusCode).toBe(200);
      if (transport === "SSE") expect(result.body).toContain("event: finish");
      await vi.waitFor(
        async () => {
          const rows =
            await t.sql`select status,type from memory_tasks where project_id=${projectId}`;
          expect(rows).toHaveLength(2);
          expect(rows.every((r) => r.status === "done")).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(await t.sql`select * from observations where project_id=${projectId}`).toHaveLength(1);
      expect(m.embedding).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  },
);
it("durable worker configuration rejects missing dependencies or competing lifecycle engines", () => {
  expect(() => buildApp({ auth: false, extractionQueue: {} })).toThrow(
    "durable extraction requires database and master key",
  );
  expect(() =>
    buildApp({
      auth: false,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      extractionQueue: {},
      taskWorker: { start: () => {}, stop: async () => ({ drained: true }) },
    }),
  ).toThrow("choose one managed task worker");
});
