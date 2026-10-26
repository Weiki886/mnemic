import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import { createApiClient } from "../../../packages/shared/src/api.js";
import { consumeChatStream } from "../../../packages/shared/src/chat-stream.js";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import type { ModelContentRecord } from "../src/debug/model-content.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb;
const key = "opaque-selected-debug-key-012345678901234567890";
const token = "debug-content-auth-opaque-012345678901234567890";
const secret = "sk-modeldebug01234567890123456789";
const masterHex = TEST_MASTER_KEY.toString("hex"),
  master64 = TEST_MASTER_KEY.toString("base64");
const output = `ANSWER ${key} ${token} ${masterHex} ${master64} ${secret}\n`;
const seen: unknown[] = [];
const factory = {
  languageModel: (_: unknown, id: string) =>
    new MockLanguageModelV2({
      doGenerate: async (opts) => {
        seen.push(opts.prompt);
        return {
          content: [{ type: "text", text: id === "extract" ? "[]" : output }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
      doStream: async (opts) => {
        seen.push(opts.prompt);
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "text-start", id: "t" });
              c.enqueue({ type: "text-delta", id: "t", delta: output.slice(0, 15) });
              c.enqueue({ type: "text-delta", id: "t", delta: output.slice(15) });
              c.enqueue({ type: "text-end", id: "t" });
              c.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              c.close();
            },
          }),
        };
      },
    }),
  embeddingModel() {
    throw Error("embedding not configured");
  },
};
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "debug-content-local",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: key,
    models: { chat: "chat", extraction: "extract" },
  });
}, 180000);
afterAll(async () => {
  await t?.close();
});
async function fixture(flags: Pick<BuildAppOptions, "debugMode" | "debugContent">) {
  const p = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'debug-content')`;
  let logs = "";
  const app = buildApp({
    ...flags,
    authToken: token,
    masterKey: TEST_MASTER_KEY,
    db: t.db,
    providerFactory: factory,
    logStream: {
      write: (value) => {
        logs += value;
      },
    },
    chatDeps: {
      retrieveFn: async () => ({
        abstained: false,
        traceId: uuidv7(),
        candidates: [
          {
            beliefId: uuidv7(),
            beliefVersionId: uuidv7(),
            subject: "DEBUG_MEMORY",
            attribute: "engine",
            value: `PostgreSQL ${secret}`,
            vectorScore: 1,
            keywordScore: 1,
            fusedScore: 1,
            selected: true,
            reason: "top_k",
          },
        ],
      }),
    },
  });
  const api = createApiClient({ baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }), token });
  return {
    p,
    app,
    api,
    log: () => logs,
    rows: () =>
      logs
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((r) => r.msg === "model debug content") as ModelContentRecord[],
  };
}
it.each([{}, { debugMode: true }, { debugMode: true, debugContent: false }])(
  "does not capture content without both explicit flags: %j",
  async (flags) => {
    const f = await fixture(flags);
    try {
      const conv = await f.api.createConversation(f.p);
      await f.api.sendMessage(f.p, conv.id, "PRIVATE_DIRECTIVE");
      await waitForChatJobs();
      expect(f.rows()).toEqual([]);
      expect(f.log()).not.toContain("PRIVATE_DIRECTIVE");
      for (const s of [key, token, secret, masterHex, master64]) expect(f.log()).not.toContain(s);
    } finally {
      await f.app.close();
    }
  },
);
it("JSON/SSE capture actual system/history/memory/file text and raw extraction output with trusted scope, no credentials", async () => {
  const f = await fixture({ debugMode: true, debugContent: true });
  try {
    const conv = await f.api.createConversation(f.p);
    const reply = await f.api.sendMessage(f.p, conv.id, `PRIVATE_DIRECTIVE ${key} ${token}`, [
      { kind: "file", path: "README.md", content: `FILE_FACT ${secret}`, truncated: false },
    ]);
    expect(reply.answer).toBe(output);
    await waitForChatJobs();
    await consumeChatStream(await f.api.openMessageStream(f.p, conv.id, "SECOND_DIRECTIVE"), {
      conversationId: conv.id,
    });
    await waitForChatJobs();
    const rows = f.rows();
    expect(rows).toHaveLength(10); // 2 chat + 3 independent extraction invocations, paired.
    const groups = new Map<string, ModelContentRecord[]>();
    for (const row of rows) groups.set(row.target_id, [...(groups.get(row.target_id) ?? []), row]);
    expect(groups.size).toBe(5);
    for (const group of groups.values()) {
      expect(group.map((r) => r.event)).toEqual(["model.prompt", "model.response"]);
      for (const row of group) {
        expect(row.detail).toMatchObject({
          project_id: f.p,
          conversation_id: conv.id,
          complete: true,
          omitted_reason: null,
        });
        expect(
          await t.sql`select id from messages where id=${row.detail.evidence_id} and conversation_id=${conv.id}`,
        ).toHaveLength(1);
      }
    }
    const chats = rows.filter((r) => r.event === "model.prompt" && r.detail.slot === "chat");
    expect(chats).toHaveLength(2);
    expect(JSON.stringify(chats[0]!.detail.content)).toContain("DEBUG_MEMORY");
    expect(JSON.stringify(chats[0]!.detail.content)).toContain("FILE_FACT");
    expect(JSON.stringify(chats[1]!.detail.content)).toContain("PRIVATE_DIRECTIVE"); // actual history retained
    expect(JSON.stringify(chats[1]!.detail.content)).toContain("SECOND_DIRECTIVE");
    expect(
      rows
        .filter((r) => r.event === "model.response" && r.detail.slot === "extraction")
        .every((r) => JSON.stringify(r.detail.content).includes("[]")),
    ).toBe(true);
    for (const s of [key, token, secret, masterHex, master64]) expect(f.log()).not.toContain(s);
    expect(f.log()).toContain("[REDACTED]");
    expect(JSON.stringify(seen)).toContain(key); // SDK/business data was not rewritten for logging.
    expect(
      (await t.sql`select raw_text from messages where id=${reply.message_id}`)[0]!.raw_text,
    ).toBe(output);
  } finally {
    await f.app.close();
  }
});
it.each(["commit", "resume"] as const)(
  "%s content capture retains physical Evidence scope and does not re-extract inherited history",
  async (action) => {
    const f = await fixture({ debugMode: true, debugContent: true });
    try {
      const conv = await f.api.createConversation(f.p),
        id = uuidv7();
      await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${id},${conv.id},'user','QUEUED_CONTENT',now())`;
      if (action === "commit") await f.api.commitConversation(conv.id);
      else {
        const resumed = await f.api.resumeConversation(f.p, conv.id);
        await f.api.commitConversation(resumed.id);
      }
      await waitForChatJobs();
      expect(f.rows()).toHaveLength(2);
      expect(f.rows()[0]!.detail).toMatchObject({
        slot: "extraction",
        conversation_id: conv.id,
        evidence_id: id,
        complete: true,
      });
      expect(JSON.stringify(f.rows()[0]!.detail.content)).toContain("QUEUED_CONTENT");
    } finally {
      await f.app.close();
    }
  },
);
