import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { modelUsage } from "../src/db/schema.js";
import type { UsageRow } from "@mnemic/shared/usage";
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

const token = "offline-usage-runtime-0000000000",
  project = uuidv7(),
  providerName = `runtime-usage-${uuidv7()}`;
let logs = "";
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  api: ReturnType<typeof createApiClient>,
  n = 0;
const factory = {
  languageModel: (_: unknown, id: string) =>
    new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [
          {
            type: "text" as const,
            text:
              id === "extract"
                ? JSON.stringify([
                    {
                      type: "decision",
                      subject: "usage-project",
                      attribute: `decision-${++n}`,
                      value: "PostgreSQL",
                      valid_time: "2026-10-25",
                      time_precision: "DAY",
                      time_confidence: 1,
                      assertion_intent: "ASSERT",
                      source_type: "USER_EXPLICIT",
                      importance: 0.99,
                      confidence: 0.99,
                      entities: ["usage-project"],
                      is_profile: true,
                    },
                  ])
                : "USAGE ANSWER",
          },
        ],
        finishReason: "stop" as const,
        usage:
          id === "extract"
            ? { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
            : { inputTokens: 17, outputTokens: 5, totalTokens: 30 },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: "USAGE ANSWER" });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 17, outputTokens: 5, totalTokens: 30 },
            });
            c.close();
          },
        }),
      }),
    }),
  embeddingModel: () =>
    new MockEmbeddingModelV2<string>({
      doEmbed: async ({ values }) => ({
        embeddings: values.map((v) => bagOfWordsVector(v)),
        usage: { tokens: 11 },
      }),
    }),
};
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`delete from provider_configs`;
  await t.sql`insert into projects(id,name) values(${project},'usage-runtime')`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: providerName,
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "NEVER-STORED-PLAIN",
    models: { chat: "chat", extraction: "extract", embedding: "embed" },
  });
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    providerFactory: factory,
    logStream: {
      write: (chunk) => {
        logs += chunk;
      },
    },
  });
  api = createApiClient({ baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }), token });
}, 180000);
afterAll(async () => {
  await app?.close();
  await t?.close();
});
it("JSON and SSE record chat, query embedding, background extraction and indexing in their physical conversation", async () => {
  const conv = await api.createConversation(project);
  expect((await api.sendMessage(project, conv.id, "persisted database decision")).answer).toBe(
    "USAGE ANSWER",
  );
  await waitForChatJobs();
  const stream = await api.openMessageStream(project, conv.id, "another decision");
  await consumeChatStream(stream, { conversationId: conv.id });
  await waitForChatJobs();
  const rows = await t.sql`select * from model_usage where project_id=${project} order by id`;
  expect(rows).toHaveLength(8);
  expect(rows.every((r) => r.conversation_id === conv.id && r.status === "success")).toBe(true);
  expect(rows.filter((r) => r.purpose === "chat")).toHaveLength(2);
  expect(rows.filter((r) => r.purpose === "extraction")).toHaveLength(2);
  expect(rows.filter((r) => r.purpose === "embedding_query")).toHaveLength(2);
  expect(rows.filter((r) => r.purpose === "embedding_index")).toHaveLength(2);
  expect(
    rows
      .filter((r) => r.slot === "chat")
      .every((r) => Number(r.prompt_tokens) === 17 && Number(r.total_tokens) === 30),
  ).toBe(true);
  expect(
    rows
      .filter((r) => r.slot === "embedding")
      .every((r) => Number(r.prompt_tokens) === 11 && r.completion_tokens === null),
  ).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(
    /NEVER-STORED-PLAIN|USAGE ANSWER|persisted database decision/,
  );
  // #36 validation chain: real calls -> persisted counters -> HTTP aggregate -> HTTP export.
  const report = await api.getUsageReport(project, {
    conversation_id: conv.id,
    group_by: "purpose",
  });
  expect(report.totals).toMatchObject({
    calls: 8,
    prompt_tokens: { reported: "92", missing_calls: 0 },
    completion_tokens: { reported: "16", missing_calls: 4 },
    total_tokens: { reported: "124", missing_calls: 0 },
  });
  const exported: UsageRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < 3; page++) {
    const result = await api.exportUsage(project, {
      conversation_id: conv.id,
      from: report.from,
      to: report.to,
      limit: 3,
      ...(after ? { after } : {}),
    });
    exported.push(...result.records);
    if (result.next_after === null) {
      after = undefined;
      break;
    }
    after = result.next_after;
  }
  expect(after).toBeUndefined();
  expect(exported).toHaveLength(8);
  expect(new Set(exported.map((r) => r.id)).size).toBe(8);
  expect(exported.reduce((sum, r) => sum + BigInt(r.total_tokens ?? "0"), 0n).toString()).toBe(
    "124",
  );
});
it("manual recall is project-scoped with no conversation and rejected requests record no model calls", async () => {
  const before = (await t.sql`select id from model_usage where project_id=${project}`).length;
  const invalid = await app.inject({
    method: "POST",
    url: `/projects/${project}/recall`,
    headers: { authorization: `Bearer ${token}` },
    payload: { query: "" },
  });
  expect(invalid.statusCode).toBe(400);
  expect(await t.sql`select id from model_usage where project_id=${project}`).toHaveLength(before);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/projects/${project}/recall`,
        headers: { authorization: `Bearer ${token}` },
        payload: { query: "PostgreSQL" },
      })
    ).statusCode,
  ).toBe(200);
  const [row] =
    await t.sql`select * from model_usage where project_id=${project} order by id desc limit 1`;
  expect(row).toMatchObject({ conversation_id: null, purpose: "embedding_query" });
});
it("plain doctor resolves without charging; explicit probe records all three invocations outside project totals", async () => {
  const before = (await t.sql`select id from model_usage where provider_name=${providerName}`)
    .length;
  expect(
    (await app.inject({ url: "/v1/doctor", headers: { authorization: `Bearer ${token}` } }))
      .statusCode,
  ).toBe(200);
  expect(await t.sql`select id from model_usage where provider_name=${providerName}`).toHaveLength(
    before,
  );
  const res = await app.inject({
    method: "POST",
    url: "/v1/doctor/probe",
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  const rows =
    await t.sql`select * from model_usage where provider_name=${providerName} and purpose='probe'`;
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.project_id === null && r.conversation_id === null)).toBe(true);
});

it("HTTP model usage failures reach application pino as fixed warnings without breaking a successful answer", async () => {
  const original = t.db.insert.bind(t.db),
    insert = vi.spyOn(t.db, "insert").mockImplementation((...args) => {
      if (args[0] === modelUsage) throw new Error("PRIVATE SQL CREDENTIALS");
      return original(...args);
    });
  logs = "";
  try {
    const conv = await api.createConversation(project);
    expect((await api.sendMessage(project, conv.id, "offline log fault")).answer).toBe(
      "USAGE ANSWER",
    );
    await waitForChatJobs();
    const rows = logs
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.filter((r) => r.msg === "model usage persistence failed")).toHaveLength(4);
    expect(
      rows.filter((r) => r.msg === "model usage persistence failed").every((r) => r.level === 40),
    ).toBe(true);
    expect(logs).not.toContain("PRIVATE SQL CREDENTIALS");
  } finally {
    insert.mockRestore();
  }
});
