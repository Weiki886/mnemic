import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2, MockEmbeddingModelV2 } from "ai/test";
import { createApiClient } from "../../../packages/shared/src/api.js";
import { consumeChatStream } from "../../../packages/shared/src/chat-stream.js";
import { buildApp } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagOfWordsVector } from "./fixtures/bag-embedding.js";
let t: TestDb,
  writes = 0,
  failIndex = false,
  degraded = false;
const token = "offline-debug-runtime-000000000000",
  secret = "sk-debugsecret012345678901234567890";
const project = uuidv7();
const factory = {
  languageModel: (_: unknown, id: string) =>
    new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [
          {
            type: "text" as const,
            text:
              id === "extract"
                ? degraded
                  ? "not json"
                  : JSON.stringify([
                      {
                        type: "decision",
                        subject: "debug-project",
                        attribute: `decision-${++writes}`,
                        value: `PostgreSQL ${secret}`,
                        valid_time: "2026-10-26",
                        time_precision: "DAY",
                        time_confidence: 1,
                        assertion_intent: "ASSERT",
                        source_type: "USER_EXPLICIT",
                        importance: 0.99,
                        confidence: 0.99,
                        entities: ["debug-project"],
                        is_profile: true,
                      },
                    ])
                : "DEBUG ANSWER",
          },
        ],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: "DEBUG ANSWER" });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            c.close();
          },
        }),
      }),
    }),
  embeddingModel: () =>
    new MockEmbeddingModelV2<string>({
      doEmbed: async ({ values }) => {
        if (failIndex && values[0]?.includes("debug-project decision-"))
          throw new Error(`PRIVATE PROVIDER ${secret}`);
        return { embeddings: values.map((v) => bagOfWordsVector(v)) };
      },
    }),
};
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`delete from provider_configs`;
  await t.sql`insert into projects(id,name) values(${project},'debug')`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "debug-offline",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { chat: "chat", extraction: "extract", embedding: "embed" },
  });
}, 180000);
afterAll(async () => {
  await t?.close();
});
async function fixture(debugMode: boolean) {
  let logs = "";
  const app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    providerFactory: factory,
    debugMode,
    logStream: {
      write: (value) => {
        logs += value;
      },
    },
  });
  const api = createApiClient({ baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }), token });
  return {
    app,
    api,
    log: () => logs,
    traces: () =>
      logs
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((r) => r.msg === "memory debug trace"),
  };
}
it("debug-off stays silent even at verbose logging; real memory operations still complete", async () => {
  vi.stubEnv("LOG_LEVEL", "debug");
  const f = await fixture(false);
  try {
    const conv = await f.api.createConversation(project);
    await f.api.sendMessage(project, conv.id, "PRIVATE DIRECTIVE");
    await waitForChatJobs();
    expect(f.traces()).toEqual([]);
    expect(await t.sql`select id from observations where project_id=${project}`).toHaveLength(1);
    expect(f.log()).not.toContain(secret);
    expect(f.log()).not.toContain("PRIVATE DIRECTIVE");
  } finally {
    await f.app.close();
    vi.unstubAllEnvs();
  }
});
it("JSON/SSE and manual recall emit correlatable metadata JSONL after durable trace/write completion", async () => {
  const f = await fixture(true);
  try {
    const conv = await f.api.createConversation(project);
    await f.api.sendMessage(project, conv.id, "PRIVATE DIRECTIVE");
    await waitForChatJobs();
    await consumeChatStream(
      await f.api.openMessageStream(project, conv.id, "PRIVATE DIRECTIVE TWO"),
      { conversationId: conv.id },
    );
    await waitForChatJobs();
    const recall = await f.api.recallBeliefs(project, "PostgreSQL");
    const rows = f.traces();
    expect(rows).toHaveLength(9);
    for (const r of rows) {
      expect(r.ts).toMatch(/^\d{4}-\d\d-/);
      expect(r.target_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.detail.project_id).toBe(project);
      expect(r.level).toBe(20);
    }
    expect(rows.filter((r) => r.event === "memory.retrieval.completed")).toHaveLength(3);
    const manual = rows.find((r) => r.target_id === recall.trace.id);
    expect(manual.detail.conversation_id).toBeNull();
    for (const r of rows.filter((r) => r.event === "memory.retrieval.completed"))
      expect(await t.sql`select id from retrieval_traces where id=${r.target_id}`).toHaveLength(1);
    for (const r of rows.filter((r) => r.event === "memory.write.completed")) {
      expect(
        await t.sql`select id from observations where id=${r.detail.observation_id} and evidence_id=${r.target_id}`,
      ).toHaveLength(1);
      expect(r.detail.route).toBe("created");
    }
    for (const value of [secret, token, "PRIVATE DIRECTIVE", "DEBUG ANSWER", "PostgreSQL"])
      expect(f.log()).not.toContain(value);
  } finally {
    await f.app.close();
  }
});
it("degraded extraction and index failures keep structured outcomes without logging provider secrets", async () => {
  const f = await fixture(true);
  try {
    degraded = true;
    const conv = await f.api.createConversation(project);
    await f.api.sendMessage(project, conv.id, "degrade");
    await waitForChatJobs();
    expect(f.traces()).toContainEqual(
      expect.objectContaining({
        event: "memory.extraction.completed",
        detail: expect.objectContaining({ degraded: true, attempts: 2, candidates_count: 0 }),
      }),
    );
    degraded = false;
    failIndex = true;
    expect((await f.api.sendMessage(project, conv.id, "index fail")).answer).toBe("DEBUG ANSWER");
    await waitForChatJobs();
    expect(f.traces()).toContainEqual(
      expect.objectContaining({
        event: "memory.write.failed",
        detail: expect.objectContaining({ phase: "ingest" }),
      }),
    );
    expect(f.log()).not.toContain(secret);
    expect(f.log()).not.toContain("PRIVATE PROVIDER");
  } finally {
    degraded = false;
    failIndex = false;
    await f.app.close();
  }
});
