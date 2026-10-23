import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { eq } from "drizzle-orm";
import { ConversationMessageSchema } from "@mnemic/shared/chat";
import { conversations } from "../src/db/schema.js";
import { loadConversationMessages, messageViews, modelHistory } from "../src/chat/context.js";
import { migrateAgain, setupTestDb, type TestDb } from "./db-helper.js";

describe("streamed message status and historical context (#33)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  }, 180000);
  afterAll(async () => {
    await t?.close();
  });

  it.each(["complete", "interrupted", "failed"] as const)(
    "persists %s metadata without copying or rewriting the partial answer",
    async (status) => {
      const columns =
        await t.sql`select column_name from information_schema.columns where table_schema='public' and table_name='messages'`;
      expect(columns.map((c) => c.column_name)).toContain("generation_status");
      await migrateAgain(t.db);
      const p = uuidv7(),
        c = uuidv7(),
        m = uuidv7();
      await t.sql`insert into projects (id,name) values (${p}, 'stream-context')`;
      await t.sql`insert into conversations (id,project_id) values (${c},${p})`;
      await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time,generation_status) values (${m},${c},'assistant','回答前缀😀',now(),${status})`;
      const [conv] = await t.db.select().from(conversations).where(eq(conversations.id, c));
      const rows = await loadConversationMessages(t.db, conv!);
      expect(rows[0]!.rawText).toBe("回答前缀😀");
      const views = await messageViews(t.db, p, rows);
      expect(views[0]).toMatchObject({ raw_text: "回答前缀😀", generation_status: status });
      const history = JSON.stringify(await modelHistory(t.db, p, rows));
      expect(history).toContain("回答前缀😀");
      if (status !== "complete") expect(history).toContain(`generation_status=${status}`);
    },
  );
  it.each(["complete", "interrupted", "failed"])(
    "shared read schema retains %s marker",
    (status) => {
      const parsed = ConversationMessageSchema.parse({
        id: uuidv7(),
        speaker: "assistant",
        raw_text: "片段",
        msg_time: new Date().toISOString(),
        memories: null,
        generation_status: status,
      });
      expect(parsed).toHaveProperty("generation_status", status);
    },
  );
});
