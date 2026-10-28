import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { enterMessage } from "../src/chat/respond.js";
import { commitConversation } from "../src/chat/service.js";
import { resumeConversation } from "../src/chat/resume.js";
import { recoverExtractionTasks } from "../src/tasks/extraction-outbox.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
async function seed() {
  const projectId = uuidv7(),
    id = uuidv7();
  await t.sql`insert into projects(id,name) values(${projectId},'outbox')`;
  await t.sql`insert into conversations(id,project_id) values(${id},${projectId})`;
  return { projectId, id };
}
const opts = () => ({ durableExtraction: true, onJob: vi.fn() });
it("physical user and sanitized file admission persist their outboxes without claiming extracted_at", async () => {
  const f = await seed();
  const r = await enterMessage(
    t.db,
    f.id,
    "hello",
    f.projectId,
    [{ kind: "file", path: "a.ts", content: "file", truncated: false }],
    true,
  );
  expect(r.kind).toBe("ok");
  const tasks = await t.sql`select * from memory_tasks where project_id=${f.projectId}`;
  expect(tasks).toHaveLength(2);
  expect(tasks.every((t) => t.type === "EXTRACT" && t.status === "queued")).toBe(true);
  expect(
    (await t.sql`select * from messages where conversation_id=${f.id}`).every(
      (m) => m.extracted_at === null,
    ),
  ).toBe(true);
});
it("admission failure rolls messages, audit and outbox back as one transaction", async () => {
  const f = await seed();
  await expect(
    t.db.transaction(async (tx) => {
      await enterMessage(tx, f.id, "hello", f.projectId, [], true);
      throw Error("crash");
    }),
  ).rejects.toThrow("crash");
  expect(await t.sql`select * from messages where conversation_id=${f.id}`).toHaveLength(0);
  expect(await t.sql`select * from memory_tasks where project_id=${f.projectId}`).toHaveLength(0);
});
it("commit atomically archives and queues physical evidence, without launching process jobs", async () => {
  const f = await seed(),
    id = uuidv7();
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${id},${f.id},'user','historic unclaimed',now())`;
  const options = opts();
  expect((await commitConversation(t.db, TEST_MASTER_KEY, f.id, options)).kind).toBe("committed");
  expect(options.onJob).not.toHaveBeenCalled();
  expect(await t.sql`select * from memory_tasks where project_id=${f.projectId}`).toHaveLength(1);
  expect(
    (await t.sql`select extracted_at from messages where id=${id}`)[0]!.extracted_at,
  ).toBeNull();
});
it("resumption only queues physical evidence and preserves atomic archive/fork admission", async () => {
  const f = await seed();
  await enterMessage(t.db, f.id, "historic user", f.projectId);
  const options = opts(),
    r = await resumeConversation(t.db, TEST_MASTER_KEY, f.projectId, f.id, undefined, options);
  expect(r.kind).toBe("resumed");
  expect(options.onJob).not.toHaveBeenCalled();
  expect(await t.sql`select * from memory_tasks where project_id=${f.projectId}`).toHaveLength(1);
  if (r.kind === "resumed")
    expect(
      await t.sql`select * from messages where conversation_id=${r.conversation.id}`,
    ).toHaveLength(0);
});
it("bounded restart recovery excludes assistants, inherited rows, completed claims and existing identities", async () => {
  const f = await seed();
  await enterMessage(t.db, f.id, "recover", f.projectId);
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${uuidv7()},${f.id},'assistant','not extraction evidence',now())`;
  expect(await recoverExtractionTasks(t.db, { projectId: f.projectId })).toBe(1);
  expect(await recoverExtractionTasks(t.db, { projectId: f.projectId })).toBe(0);
  expect(await t.sql`select * from memory_tasks where project_id=${f.projectId}`).toHaveLength(1);
});
it("recovery never re-extracts manual correction Evidence already handled by its owning path", async () => {
  const f = await seed();
  await t.sql`update conversations set title='manual-corrections' where id=${f.id}`;
  await enterMessage(t.db, f.id, "manual correction", f.projectId);
  expect(await recoverExtractionTasks(t.db, { projectId: f.projectId })).toBe(0);
});
it.each(["message", "commit", "resume"])(
  "outbox enqueue failure rolls back %s admission",
  async (mode) => {
    const repository = await import("../src/tasks/repository.js");
    const f = await seed();
    if (mode !== "message") await enterMessage(t.db, f.id, "before", f.projectId);
    const enqueue = vi
      .spyOn(repository, "enqueueTask")
      .mockRejectedValueOnce(Error("outbox unavailable"));
    try {
      if (mode === "message")
        await expect(enterMessage(t.db, f.id, "new", f.projectId, [], true)).rejects.toThrow(
          "outbox unavailable",
        );
      else if (mode === "commit")
        await expect(commitConversation(t.db, TEST_MASTER_KEY, f.id, opts())).rejects.toThrow(
          "outbox unavailable",
        );
      else
        await expect(
          resumeConversation(t.db, TEST_MASTER_KEY, f.projectId, f.id, undefined, opts()),
        ).rejects.toThrow("outbox unavailable");
    } finally {
      enqueue.mockRestore();
    }
    expect(
      (await t.sql`select ended_at from conversations where id=${f.id}`)[0]!.ended_at,
    ).toBeNull();
    expect(await t.sql`select * from conversations where project_id=${f.projectId}`).toHaveLength(
      1,
    );
    expect(await t.sql`select * from messages where conversation_id=${f.id}`).toHaveLength(
      mode === "message" ? 0 : 1,
    );
    expect(await t.sql`select * from memory_tasks where project_id=${f.projectId}`).toHaveLength(0);
  },
);
