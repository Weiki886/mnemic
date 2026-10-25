import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateText, embed, streamText } from "ai";
import { MockLanguageModelV2, MockEmbeddingModelV2 } from "ai/test";
import { observeLanguage, observeEmbedding } from "../src/usage/models.js";
import type { UsageRecord } from "../src/usage/repository.js";
import { extractCandidates } from "../src/extraction/extractor.js";
import { realProviderFactory } from "../src/providers/factory.js";

const base = {
  providerName: "provider",
  modelId: "configured-model",
  slot: "chat" as const,
  purpose: "chat" as const,
  projectId: null,
  conversationId: null,
};
const usage = {
  inputTokens: 12,
  outputTokens: 4,
  totalTokens: 21,
  reasoningTokens: 5,
  cachedInputTokens: 3,
};
function result(text = "answer") {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: "stop" as const,
    usage,
    warnings: [],
  };
}
type Part =
  Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer T>
    ? T
    : never;
const params = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "secret prompt" }] }],
};
it("generateText preserves output while recording exact provider counts, without prompt/response", async () => {
  const rows: UsageRecord[] = [];
  const model = observeLanguage(
    new MockLanguageModelV2({ doGenerate: async () => result() }),
    base,
    async (r) => {
      rows.push(r);
    },
  );
  expect((await generateText({ model, prompt: "secret prompt" })).text).toBe("answer");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ...base,
    status: "success",
    promptTokens: 12,
    completionTokens: 4,
    totalTokens: 21,
    reasoningTokens: 5,
    cachedInputTokens: 3,
  });
  expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(rows)).not.toMatch(/secret prompt|answer/);
});
it("extraction schema retries record every paid attempt, even when model output is rejected", async () => {
  const rows: UsageRecord[] = [];
  let n = 0;
  const model = observeLanguage(
    new MockLanguageModelV2({ doGenerate: async () => result(++n === 1 ? "bad" : "[]") }),
    { ...base, slot: "extraction", purpose: "extraction" },
    async (r) => {
      rows.push(r);
    },
  );
  expect((await extractCandidates(model, "input")).attempts).toBe(2);
  expect(rows.map((r) => r.promptTokens)).toEqual([12, 12]);
});
it("provider errors are recorded once and the original exception is rethrown", async () => {
  const rows: UsageRecord[] = [],
    error = new Error("sensitive provider payload");
  const model = observeLanguage(
    new MockLanguageModelV2({
      doGenerate: async () => {
        throw error;
      },
    }),
    base,
    async (r) => {
      rows.push(r);
    },
  );
  await expect(generateText({ model, prompt: "x", maxRetries: 0 })).rejects.toBe(error);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "error", promptTokens: null, totalTokens: null });
  expect(JSON.stringify(rows)).not.toContain("sensitive");
});
it("embedding counts are input only and batch capability properties survive wrapping", async () => {
  const rows: UsageRecord[] = [];
  const original = new MockEmbeddingModelV2({
    maxEmbeddingsPerCall: 7,
    supportsParallelCalls: false,
    doEmbed: async () => ({ embeddings: [[1, 2]], usage: { tokens: 9 } }),
  });
  const model = observeEmbedding(
    original,
    { ...base, slot: "embedding", purpose: "embedding_query" },
    async (r) => {
      rows.push(r);
    },
  );
  expect(model.maxEmbeddingsPerCall).toBe(7);
  expect(model.supportsParallelCalls).toBe(false);
  expect((await embed({ model, value: "x" })).embedding).toEqual([1, 2]);
  expect(rows[0]).toMatchObject({ promptTokens: 9, completionTokens: null, totalTokens: 9 });
});
it("unknown or invalid token counters stay null rather than zero or fabricated totals", async () => {
  const rows: UsageRecord[] = [];
  const model = observeLanguage(
    new MockLanguageModelV2({
      doGenerate: async () => ({
        ...result(),
        usage: {
          inputTokens: NaN,
          outputTokens: -1,
          totalTokens: undefined,
          reasoningTokens: Infinity,
          cachedInputTokens: 1.5,
        },
      }),
    }),
    base,
    async (r) => {
      rows.push(r);
    },
  );
  await generateText({ model, prompt: "x" });
  expect(rows[0]).toMatchObject({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
  });
});
it("usage sink failures do not replay a successful model request or leak their payload", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}),
    call = vi.fn(async () => result());
  try {
    const model = observeLanguage(new MockLanguageModelV2({ doGenerate: call }), base, async () => {
      throw new Error("DB-secret");
    });
    expect((await generateText({ model, prompt: "x" })).text).toBe("answer");
    expect(call).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("model usage persistence failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("DB-secret");
  } finally {
    warn.mockRestore();
  }
});
it("streamText preserves deltas and records terminal usage once, after real completion", async () => {
  const rows: UsageRecord[] = [];
  const original = new MockLanguageModelV2({
    doStream: async () => ({
      stream: new ReadableStream<Part>({
        start(c) {
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: "hello" });
          c.enqueue({ type: "text-end", id: "t" });
          c.enqueue({ type: "finish", finishReason: "stop", usage });
          c.close();
        },
      }),
    }),
  });
  const model = observeLanguage(original, base, async (r) => {
    rows.push(r);
  });
  const stream = streamText({ model, prompt: "x" });
  let text = "";
  for await (const delta of stream.textStream) text += delta;
  expect(text).toBe("hello");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "success", totalTokens: 21 });
});
it("EOF without finish and provider error frames are errors rather than free successes", async () => {
  for (const failFrame of [true, false]) {
    const rows: UsageRecord[] = [];
    const model = observeLanguage(
      new MockLanguageModelV2({
        doStream: async () => ({
          stream: new ReadableStream<Part>({
            start(c) {
              if (failFrame) c.enqueue({ type: "error", error: new Error("secret") });
              c.close();
            },
          }),
        }),
      }),
      base,
      async (r) => {
        rows.push(r);
      },
    );
    const r = await model.doStream(params);
    for await (const _ of r.stream) {
      /* consume */
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "error", totalTokens: null });
  }
});
it("cancelling a stalled stream records aborted once, even when signal and cancel both arrive", async () => {
  const rows: UsageRecord[] = [],
    controller = new AbortController();
  let saved!: () => void;
  const persisted = new Promise<void>((r) => {
    saved = r;
  });
  const model = observeLanguage(
    new MockLanguageModelV2({ doStream: async () => ({ stream: new ReadableStream<Part>() }) }),
    base,
    async (r) => {
      rows.push(r);
      saved();
    },
  );
  const stream = await model.doStream({ ...params, abortSignal: controller.signal });
  controller.abort();
  await stream.stream.cancel();
  await persisted;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "aborted", totalTokens: null });
});
it("an already-aborted request never invokes the provider and creates no phantom usage", async () => {
  const rows: UsageRecord[] = [],
    controller = new AbortController(),
    call = vi.fn(async () => result());
  controller.abort();
  const model = observeLanguage(new MockLanguageModelV2({ doGenerate: call }), base, async (r) => {
    rows.push(r);
  });
  await expect(model.doGenerate({ ...params, abortSignal: controller.signal })).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
  expect(rows).toEqual([]);
});

it("SDK transport retries become separate error and success rows against a real offline HTTP endpoint", async () => {
  const rows: UsageRecord[] = [];
  let calls = 0;
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    if (++calls === 1) {
      res.writeHead(503);
      res.end('{"error":{"message":"retry"}}');
    } else
      res.end(
        JSON.stringify({
          id: "local",
          object: "chat.completion",
          created: 0,
          model: "model",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
        }),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const raw = realProviderFactory.languageModel(
      {
        id: "local",
        name: "local",
        protocol: "openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "offline",
        models: {},
        createdAt: new Date(),
      },
      "model",
    );
    if (typeof raw === "string") throw new Error("expected instance");
    const model = observeLanguage(raw, base, async (r) => {
      rows.push(r);
    });
    expect((await generateText({ model, prompt: "offline", maxRetries: 1 })).text).toBe("ok");
    expect(calls).toBe(2);
    expect(rows.map((r) => r.status)).toEqual(["error", "success"]);
    expect(rows[0]!.totalTokens).toBeNull();
    expect(rows[1]!.totalTokens).toBe(15);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

it("embedding failures and stream-open failures retain the original error with unknown counters", async () => {
  const rows: UsageRecord[] = [],
    error = new Error("private error body");
  const embedding = observeEmbedding(
    new MockEmbeddingModelV2({
      doEmbed: async () => {
        throw error;
      },
    }),
    { ...base, slot: "embedding" },
    async (r) => {
      rows.push(r);
    },
  );
  await expect(embed({ model: embedding, value: "x", maxRetries: 0 })).rejects.toBe(error);
  const model = observeLanguage(
    new MockLanguageModelV2({
      doStream: async () => {
        throw error;
      },
    }),
    base,
    async (r) => {
      rows.push(r);
    },
  );
  await expect(model.doStream(params)).rejects.toBe(error);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.status === "error" && r.totalTokens === null)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("private error body");
});
