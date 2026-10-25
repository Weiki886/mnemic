import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { setupTestDb, migrateAgain, type TestDb } from "./db-helper.js";
import { writeModelUsage, type UsageRecord } from "../src/usage/repository.js";

let t: TestDb;
const project = uuidv7(),
  other = uuidv7(),
  conversation = uuidv7();
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${project},'usage'),(${other},'other')`;
  await t.sql`insert into conversations(id,project_id) values(${conversation},${project})`;
}, 180000);
afterAll(async () => {
  await t?.close();
});
function record(): UsageRecord {
  return {
    projectId: project,
    conversationId: conversation,
    providerName: "offline",
    modelId: "chat",
    slot: "chat",
    purpose: "chat",
    status: "success",
    startedAt: new Date("2026-10-25T00:00:00Z"),
    durationMs: 12,
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 18,
    reasoningTokens: 3,
    cachedInputTokens: 2,
  };
}
it("persists exact reported counts and physical project/conversation scope without content snapshots", async () => {
  await writeModelUsage(t.db, record());
  const [row] = await t.sql`select * from model_usage where project_id=${project}`;
  expect(row).toMatchObject({
    conversation_id: conversation,
    provider_name: "offline",
    model_id: "chat",
    slot: "chat",
    purpose: "chat",
    status: "success",
    duration_ms: "12",
    prompt_tokens: "10",
    completion_tokens: "4",
    total_tokens: "18",
    reasoning_tokens: "3",
    cached_input_tokens: "2",
  });
  const cols =
    await t.sql`select column_name from information_schema.columns where table_schema='public' and table_name='model_usage'`;
  expect(cols.map((c) => c.column_name)).not.toEqual(
    expect.arrayContaining(["prompt", "response"]),
  );
  for (const forbidden of [
    "prompt",
    "response",
    "content",
    "api_key",
    "error",
    "raw_text",
    "base_url",
  ])
    expect(cols.map((c) => c.column_name)).not.toContain(forbidden);
});
it("rejects a conversation from another project before storing a misleading usage row", async () => {
  await expect(writeModelUsage(t.db, { ...record(), projectId: other })).rejects.toThrow(
    "usage scope",
  );
  expect(await t.sql`select id from model_usage where project_id=${other}`).toHaveLength(0);
});
it("unknown usage and projectless probes remain null rather than estimated zero", async () => {
  await writeModelUsage(t.db, {
    ...record(),
    projectId: null,
    conversationId: null,
    purpose: "probe",
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
  });
  const [row] =
    await t.sql`select * from model_usage where purpose='probe' and provider_name='offline' order by id desc limit 1`;
  expect(row).toMatchObject({
    project_id: null,
    conversation_id: null,
    prompt_tokens: null,
    total_tokens: null,
  });
});
it("migration can run again and negative token counts are rejected by PostgreSQL", async () => {
  await migrateAgain(t.db);
  await expect(
    t.sql`insert into model_usage(id,provider_name,model_id,slot,purpose,status,started_at,duration_ms,prompt_tokens) values(${uuidv7()},'x','x','chat','chat','success',now(),0,-1)`,
  ).rejects.toThrow();
});
