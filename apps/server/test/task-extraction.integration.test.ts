import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { createProvider } from "../src/providers/repository.js";
import { claimTasks, enqueueTask } from "../src/tasks/repository.js";
import { createMemoryTaskHandlers } from "../src/tasks/memory-handlers.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { durableModels, candidate } from "./fixtures/durable-models.js";
let t: TestDb;
const models = durableModels();
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
beforeEach(async () => {
  models.generate.mockClear();
  models.embedding.mockClear();
  models.output([candidate()]);
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "durable",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline-key",
    models: { extraction: "extract", embedding: "embed" },
  });
});
afterAll(async () => {
  await t?.close();
});
async function seed() {
  const projectId = uuidv7(),
    conversationId = uuidv7(),
    id = uuidv7();
  await t.sql`insert into projects(id,name) values(${projectId},'durable')`;
  await t.sql`insert into conversations(id,project_id) values(${conversationId},${projectId})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${id},${conversationId},'user','database decision',now())`;
  return { projectId, conversationId, id };
}
async function claim(f: Awaited<ReturnType<typeof seed>>, key = uuidv7()) {
  await enqueueTask(t.db, {
    projectId: f.projectId,
    type: "EXTRACT",
    payload: { evidence_id: f.id },
    idempotencyKey: key,
  });
  return (
    await claimTasks(t.db, { projectId: f.projectId, types: ["EXTRACT"], leaseMs: 10000 })
  )[0]!;
}
const context = () => ({ signal: new AbortController().signal, checkpoint: () => {} });
function handlers() {
  return createMemoryTaskHandlers(t.db, TEST_MASTER_KEY, { factory: models.factory });
}
it("real extraction commits once with receipt, duplicate delivery makes no second model call or evidence", async () => {
  const f = await seed(),
    h = handlers();
  await h.EXTRACT(await claim(f), context());
  await h.EXTRACT(await claim(f), context());
  expect(models.generate).toHaveBeenCalledTimes(1);
  const [b] = await t.sql`select * from beliefs where project_id=${f.projectId}`;
  expect(b!.evidence_count).toBe(1);
  expect(await t.sql`select * from observations where evidence_id=${f.id}`).toHaveLength(1);
  const tasks = await t.sql`select type,status from memory_tasks where project_id=${f.projectId}`;
  expect(tasks.filter((r) => r.type === "EXTRACT" && r.status === "done")).toHaveLength(2);
  expect(tasks.filter((r) => r.type === "REEMBED" && r.status === "queued")).toHaveLength(1);
  expect(
    (await t.sql`select extracted_at from messages where id=${f.id}`)[0]!.extracted_at,
  ).not.toBeNull();
  const [index] = await claimTasks(t.db, { projectId: f.projectId, types: ["REEMBED"] });
  await h.REEMBED(index!, context());
  expect(models.embedding).toHaveBeenCalledTimes(1);
  expect(
    await t.sql`select e.* from memory_embeddings e join belief_versions v on e.belief_version_id=v.id join beliefs b on b.id=v.belief_id where b.project_id=${f.projectId}`,
  ).toHaveLength(1);
});
it("failed checkpoint rolls back all candidate effects, outbox, extracted flag and success events", async () => {
  const f = await seed(),
    task = await claim(f),
    events: unknown[] = [];
  const h = createMemoryTaskHandlers(t.db, TEST_MASTER_KEY, {
    factory: models.factory,
    debugTrace: (e) => events.push(e),
  });
  let checkpoints = 0;
  await expect(
    h.EXTRACT(task, {
      signal: new AbortController().signal,
      checkpoint: () => {
        if (++checkpoints >= 4) throw Error("injected rollback");
      },
    }),
  ).rejects.toThrow();
  expect(await t.sql`select * from observations where evidence_id=${f.id}`).toHaveLength(0);
  expect(await t.sql`select * from beliefs where project_id=${f.projectId}`).toHaveLength(0);
  expect(
    await t.sql`select * from memory_tasks where project_id=${f.projectId} and type='REEMBED'`,
  ).toHaveLength(0);
  expect(
    (await t.sql`select extracted_at from messages where id=${f.id}`)[0]!.extracted_at,
  ).toBeNull();
  expect(JSON.stringify(events)).not.toContain("memory.write.completed");
});
it("SKIP and PENDING are durable outcomes and duplicate delivery never repeats pending rows", async () => {
  const f = await seed();
  models.output([
    candidate({ confidence: 0.1 }),
    candidate({ attribute: "hosting", confidence: 0.5 }),
  ]);
  const h = handlers();
  await h.EXTRACT(await claim(f), context());
  await h.EXTRACT(await claim(f), context());
  expect(await t.sql`select * from pending_candidates where evidence_id=${f.id}`).toHaveLength(1);
  expect(await t.sql`select * from observations where evidence_id=${f.id}`).toHaveLength(0);
  expect(models.generate).toHaveBeenCalledTimes(1);
});
it("corrupted or foreign file parents fail before model invocation", async () => {
  const f = await seed(),
    foreign = await seed();
  await t.sql`update messages set speaker='tool', attachment=${JSON.stringify({ version: 1, kind: "file", path: "a.ts", truncated: false, parent_message_id: foreign.id, source_type: "PROJECT_FILE" })} where id=${f.id}`;
  await expect(handlers().EXTRACT(await claim(f), context())).rejects.toThrow();
  expect(models.generate).not.toHaveBeenCalled();
});
it("file authority is recomputed and embedding failure leaves facts durable and retryable", async () => {
  const f = await seed(),
    file = uuidv7();
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time,attachment) values(${file},${f.conversationId},'tool','file fact',now(),${JSON.stringify({ version: 1, kind: "file", path: "a.ts", truncated: false, parent_message_id: f.id, source_type: "PROJECT_FILE" })})`;
  models.output([candidate({ source_type: "USER_CORRECTION" })]);
  const h = handlers();
  await h.EXTRACT(await claim({ ...f, id: file }), context());
  expect(
    (await t.sql`select source_type,authority from observations where evidence_id=${file}`)[0],
  ).toMatchObject({ source_type: "PROJECT_FILE", authority: 50 });
  const [index] = await claimTasks(t.db, { projectId: f.projectId, types: ["REEMBED"] });
  models.embedding.mockRejectedValueOnce(Error("offline"));
  await expect(h.REEMBED(index!, context())).rejects.toThrow();
  await h.REEMBED(index!, context());
  expect(await t.sql`select * from observations where evidence_id=${file}`).toHaveLength(1);
  expect((await t.sql`select status from memory_tasks where id=${index!.id}`)[0]!.status).toBe(
    "done",
  );
});
it("degraded extraction is a failed attempt, never a successful empty receipt", async () => {
  const f = await seed(),
    task = await claim(f);
  models.output({ invalid: true });
  await expect(handlers().EXTRACT(task, context())).rejects.toThrow("extraction degraded");
  expect((await t.sql`select status from memory_tasks where id=${task.id}`)[0]!.status).toBe(
    "running",
  );
  expect(
    (await t.sql`select extracted_at from messages where id=${f.id}`)[0]!.extracted_at,
  ).toBeNull();
});
it("parallel deliveries with different identities serialize the Evidence commit, including PENDING", async () => {
  const f = await seed();
  models.output([candidate(), candidate({ attribute: "hosting", confidence: 0.5 })]);
  const first = await claim(f),
    second = await claim(f),
    h = handlers();
  const normal = models.generate.getMockImplementation()!;
  let entered = 0,
    release!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Keep both initial Evidence reads before either commit; otherwise a valid dedup can skip call #2.
  await models.generate.withImplementation(
    async () => {
      if (++entered === 2) release();
      await bothEntered;
      return normal();
    },
    async () => {
      await Promise.all([h.EXTRACT(first, context()), h.EXTRACT(second, context())]);
    },
  );
  expect(models.generate).toHaveBeenCalledTimes(2);
  expect(await t.sql`select * from observations where evidence_id=${f.id}`).toHaveLength(1);
  expect(await t.sql`select * from pending_candidates where evidence_id=${f.id}`).toHaveLength(1);
  expect(
    (await t.sql`select evidence_count from beliefs where project_id=${f.projectId}`)[0]!
      .evidence_count,
  ).toBe(1);
});
it("expired model result cannot commit memory effects and emits a content-free failure trace", async () => {
  const f = await seed(),
    task = await claim(f),
    normal = models.generate.getMockImplementation()!;
  models.generate.mockImplementationOnce(async () => {
    const result = await normal();
    await t.sql`update memory_tasks set lease_expires_at=clock_timestamp()-interval '1 second' where id=${task.id}`;
    return result;
  });
  const events: unknown[] = [];
  await expect(
    createMemoryTaskHandlers(t.db, TEST_MASTER_KEY, {
      factory: models.factory,
      debugTrace: (e) => events.push(e),
    }).EXTRACT(task, context()),
  ).rejects.toThrow("task lease lost");
  expect(await t.sql`select * from observations where evidence_id=${f.id}`).toHaveLength(0);
  expect(JSON.stringify(events)).toContain("memory.write.failed");
  expect(JSON.stringify(events)).not.toContain("memory.write.completed");
});
it.each(["legacy", "durable"])(
  "%s Gate failure preserves the gate diagnostic phase",
  async (mode) => {
    const pipeline = await import("../src/gate/pipeline.js");
    const writeback = await import("../src/chat/writeback.js");
    const f = await seed(),
      events: unknown[] = [];
    const opts = { factory: models.factory, debugTrace: (e: unknown) => events.push(e) };
    const process = vi
      .spyOn(pipeline, "processCandidate")
      .mockRejectedValueOnce(Error("injected gate failure"));
    try {
      const work =
        mode === "legacy"
          ? writeback.runExtractionWriteback(
              t.db,
              TEST_MASTER_KEY,
              { projectId: f.projectId, evidenceId: f.id, text: "database decision" },
              opts,
            )
          : createMemoryTaskHandlers(t.db, TEST_MASTER_KEY, opts).EXTRACT(
              await claim(f),
              context(),
            );
      await expect(work).rejects.toThrow("injected gate failure");
    } finally {
      process.mockRestore();
    }
    expect(events).toContainEqual({
      event: "memory.write.failed",
      target_id: f.id,
      detail: { project_id: f.projectId, conversation_id: f.conversationId, phase: "gate" },
    });
  },
);
