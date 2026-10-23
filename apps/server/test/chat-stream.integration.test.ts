import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModel } from "ai";
import { consumeChatStream } from "../../../packages/shared/src/chat-stream.js";
import { buildApp } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";

type Chunk =
  Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer T>
    ? T
    : never;
const token = "offline-stream-test-token-0000000000";
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
describe("server streaming with actual HTTP, SDK and PostgreSQL (#33 part 2)", () => {
  let t: TestDb, app: ReturnType<typeof buildApp>, url: string;
  let mode: "gated" | "silent" | "error" = "gated";
  let source: ReadableStreamDefaultController<Chunk> | undefined;
  let modelSignal: AbortSignal | undefined;
  let calls = 0,
    extractions = 0,
    logs = "";
  const prompts: unknown[] = [];
  const factory = {
    ...bagEmbeddingFactory,
    languageModel: (_cfg: unknown, id: string) =>
      new MockLanguageModelV2({
        doGenerate: async (opts) => {
          if (id === "chat") prompts.push(opts.prompt);
          else extractions++;
          return {
            content: [{ type: "text", text: id === "chat" ? "继续" : "[]" }],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        },
        doStream: async (opts) => {
          calls++;
          prompts.push(opts.prompt);
          modelSignal = opts.abortSignal;
          return {
            stream: new ReadableStream<Chunk>({
              start(controller) {
                source = controller;
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "text" });
                if (mode !== "silent")
                  controller.enqueue({ type: "text-delta", id: "text", delta: "partial😀" });
                if (mode === "error") {
                  controller.enqueue({ type: "error", error: new Error("secret-provider-body") });
                  controller.close();
                  source = undefined;
                }
              },
            }),
          };
        },
      }) as unknown as LanguageModel,
  };
  const makeApp = (streamTimeoutMs?: number) =>
    buildApp({
      authToken: token,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      providerFactory: factory,
      logStream: {
        write: (chunk) => {
          logs += chunk;
        },
      },
      chatDeps: {
        retrieveFn: async () => ({ candidates: [], abstained: true, traceId: uuidv7() }),
        ...(streamTimeoutMs ? { streamTimeoutMs } : {}),
      },
    });
  beforeAll(async () => {
    t = await setupTestDb();
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "stream-offline",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "offline-key",
      models: { chat: "chat", extraction: "extract", embedding: "bag" },
    });
    app = makeApp();
    url = await app.listen({ host: "127.0.0.1", port: 0 });
  }, 180000);
  afterEach(async () => {
    try {
      source?.close();
    } catch {
      /* already cancelled/closed */
    }
    source = undefined;
    mode = "gated";
    await waitForChatJobs();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });
  async function seed() {
    const p = uuidv7(),
      c = uuidv7();
    await t.sql`insert into projects (id,name) values (${p},'stream')`;
    await t.sql`insert into conversations (id,project_id) values (${c},${p})`;
    return { p, c };
  }
  const base = (s: { p: string; c: string }) => `/projects/${s.p}/conversations/${s.c}`;
  const open = async (s: { p: string; c: string }, origin = url) => {
    const r = await fetch(origin + base(s) + "/messages/stream", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "记住这一轮问题" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-request-id")).toBeTruthy();
    return r;
  };
  const cancel = (s: { p: string; c: string }, id: string) =>
    fetch(url + base(s) + `/generations/${id}/cancel`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
  function finish() {
    source!.enqueue({ type: "text-end", id: "text" });
    source!.enqueue({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    source!.close();
    source = undefined;
  }
  async function saved(id: string) {
    return (
      await t.sql`select raw_text,generation_status,memories from messages where id=${id}`
    )[0];
  }

  it("delivers delta before upstream completion and saves before emitting finish", async () => {
    const s = await seed();
    let sawDelta = false;
    const r = await consumeChatStream(await open(s), {
      conversationId: s.c,
      onEvent: async (e) => {
        if (e.type === "delta") {
          sawDelta = true;
          finish();
        }
        if (e.type === "finish")
          expect(await saved(e.message_id)).toMatchObject({
            raw_text: "partial😀",
            generation_status: "complete",
            memories: null,
          });
      },
    });
    expect(sawDelta).toBe(true);
    expect(r.status).toBe("complete");
    expect(r.reply.answer).toBe("partial😀");
    const repeated = await cancel(s, r.generationId);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      status: "complete",
      message_id: r.reply.message_id,
    });
  });
  it("explicit cancel acknowledges saved partial, and next JSON turn receives interrupted context", async () => {
    const s = await seed();
    const before = extractions;
    const r = await consumeChatStream(await open(s), {
      conversationId: s.c,
      onEvent: async (e) => {
        if (e.type === "delta") {
          const ack = await cancel(s, e.generation_id);
          expect(ack.status).toBe(200);
          expect(await ack.json()).toMatchObject({
            status: "interrupted",
            generation_id: e.generation_id,
            message_id: e.generation_id,
          });
          expect(modelSignal!.aborted).toBe(true);
        }
      },
    });
    expect(r.status).toBe("interrupted");
    expect(await saved(r.reply.message_id)).toMatchObject({
      raw_text: r.reply.answer,
      generation_status: "interrupted",
    });
    const next = await app.inject({
      method: "POST",
      url: `/v1/conversations/${s.c}/messages`,
      headers: auth,
      payload: { text: "继续刚才的问题" },
    });
    expect(next.statusCode).toBe(200);
    expect(JSON.stringify(prompts.at(-1))).toContain("partial😀");
    expect(JSON.stringify(prompts.at(-1))).toContain("generation_status=interrupted");
    await waitForChatJobs();
    await app.inject({ method: "POST", url: `/v1/conversations/${s.c}/commit`, headers: auth });
    await waitForChatJobs();
    expect(extractions - before).toBe(2); // one per new user message, no re-extraction at commit
    expect((await cancel(s, r.generationId)).status).toBe(200);
  });
  it("rejects unauthorized, invalid, foreign and ended requests before writes or model calls", async () => {
    const s = await seed(),
      foreign = await seed();
    const before = calls;
    expect(
      (
        await app.inject({
          method: "POST",
          url: base(s) + "/messages/stream",
          payload: { text: "x" },
        })
      ).statusCode,
    ).toBe(401);
    for (const path of [base(s).replace(s.c, "invalid"), base(s).replace(s.p, "invalid")]) {
      const bad = await app.inject({
        method: "POST",
        url: path + "/messages/stream",
        headers: auth,
        payload: { text: "x" },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().errors.length).toBeGreaterThan(0);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: base(s) + "/messages/stream",
          headers: auth,
          payload: { text: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: base({ p: foreign.p, c: s.c }) + "/messages/stream",
          headers: auth,
          payload: { text: "x" },
        })
      ).statusCode,
    ).toBe(404);
    expect((await cancel({ p: foreign.p, c: s.c }, uuidv7())).status).toBe(404);
    await t.sql`update conversations set ended_at=now() where id=${s.c}`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: base(s) + "/messages/stream",
          headers: auth,
          payload: { text: "x" },
        })
      ).statusCode,
    ).toBe(409);
    expect(calls).toBe(before);
    expect(await t.sql`select id from messages where conversation_id=${s.c}`).toHaveLength(0);
  });
  it("concurrent stream, JSON, commit and resume mutations conflict until persistence finishes", async () => {
    const s = await seed();
    await consumeChatStream(await open(s), {
      conversationId: s.c,
      onEvent: async (e) => {
        if (e.type !== "delta") return;
        for (const path of [
          base(s) + "/messages/stream",
          `/v1/conversations/${s.c}/messages`,
          `/v1/conversations/${s.c}/commit`,
          base(s) + "/resume",
        ]) {
          const r = await app.inject({
            method: "POST",
            url: path,
            headers: auth,
            payload:
              path.endsWith("messages") || path.endsWith("stream") ? { text: "overlap" } : {},
          });
          expect(r.statusCode, path).toBe(409);
        }
        const foreign = await seed();
        expect((await cancel(foreign, e.generation_id)).status).toBe(404);
        await cancel(s, e.generation_id);
      },
    });
    expect(await t.sql`select id from messages where conversation_id=${s.c}`).toHaveLength(2);
  });
  it("a provider error saves failed partial without raw errors or automatic retries", async () => {
    mode = "error";
    const s = await seed(),
      before = calls;
    const error = await consumeChatStream(await open(s), { conversationId: s.c }).catch((e) => e);
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.progress.terminal.code).toBe("GENERATION_FAILED");
    expect(await saved(error.progress.generationId)).toMatchObject({
      raw_text: "partial😀",
      generation_status: "failed",
    });
    expect(calls - before).toBe(1);
    expect(logs).not.toContain("secret-provider-body");
  });
  it("client disconnect aborts provider and retains unconfirmed partial in the conversation", async () => {
    const s = await seed(),
      controller = new AbortController();
    const error = await consumeChatStream(await open(s), {
      conversationId: s.c,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === "delta") controller.abort();
      },
    }).catch((e) => e);
    expect(error.code).toBe("ABORTED");
    expect(error.progress.terminal).toBeUndefined();
    await vi.waitFor(async () =>
      expect(await saved(error.progress.generationId)).toMatchObject({
        raw_text: "partial😀",
        generation_status: "interrupted",
      }),
    );
    expect(modelSignal!.aborted).toBe(true);
  });
  it("cancel before first delta saves empty interrupted answer and user evidence", async () => {
    mode = "silent";
    const s = await seed();
    const r = await consumeChatStream(await open(s), {
      conversationId: s.c,
      onEvent: async (e) => {
        if (e.type === "start") expect((await cancel(s, e.generation_id)).status).toBe(200);
      },
    });
    expect(r.status).toBe("interrupted");
    expect(r.reply.answer).toBe("");
    expect(await saved(r.reply.message_id)).toMatchObject({
      generation_status: "interrupted",
      raw_text: "",
    });
  });
  it("deadline persists interruption even if the fake upstream never settles", async () => {
    mode = "silent";
    const local = makeApp(50);
    const origin = await local.listen({ host: "127.0.0.1", port: 0 });
    try {
      const s = await seed();
      const r = await consumeChatStream(await open(s, origin), {
        conversationId: s.c,
        timeoutMs: 2000,
      });
      expect(r.status).toBe("interrupted");
      expect(await saved(r.reply.message_id)).toMatchObject({ generation_status: "interrupted" });
    } finally {
      await local.close();
    }
  });
});
