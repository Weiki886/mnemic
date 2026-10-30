import { expect, it, vi } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV2, MockEmbeddingModelV2 } from "ai/test";
import { observeLanguage, observeEmbedding } from "../src/usage/models.js";
const base = {
  projectId: null,
  conversationId: null,
  providerName: "offline",
  modelId: "model",
  slot: "chat" as const,
  purpose: "chat" as const,
};
const result = {
  content: [{ type: "text" as const, text: "ok" }],
  finishReason: "stop" as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  warnings: [],
};
const params = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "private" }] }],
};
it("generate/stream/embed deny before provider, telemetry and debug capture", async () => {
  const denied = Error("quota"),
    admit = vi.fn(async () => {
      throw denied;
    }),
    sink = vi.fn(),
    debug = vi.fn();
  const generate = vi.fn(async () => result),
    stream = vi.fn(async () => ({ stream: new ReadableStream() })),
    embed = vi.fn(async () => ({ embeddings: [[1]] }));
  const model = observeLanguage(
    new MockLanguageModelV2({ doGenerate: generate, doStream: stream }),
    base,
    sink,
    undefined,
    debug,
    admit,
  );
  await expect(model.doGenerate(params)).rejects.toBe(denied);
  await expect(model.doStream(params)).rejects.toBe(denied);
  const embedding = observeEmbedding(
    new MockEmbeddingModelV2({ doEmbed: embed }),
    { ...base, slot: "embedding" },
    sink,
    undefined,
    admit,
  );
  await expect(embedding.doEmbed({ values: ["x"] })).rejects.toBe(denied);
  expect(admit).toHaveBeenCalledTimes(3);
  for (const spy of [generate, stream, embed, sink, debug]) expect(spy).not.toHaveBeenCalled();
});
it("an already aborted call never reserves; cancellation during reservation never invokes the provider", async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const pending = new Promise<void>((r) => {
      release = r;
    }),
    admit = vi.fn(() => {
      entered();
      return pending;
    }),
    call = vi.fn(async () => result),
    sink = vi.fn();
  const model = observeLanguage(
    new MockLanguageModelV2({ doGenerate: call }),
    base,
    sink,
    undefined,
    undefined,
    admit,
  );
  await expect(model.doGenerate({ ...params, abortSignal: AbortSignal.abort() })).rejects.toThrow();
  expect(admit).not.toHaveBeenCalled();
  const abort = new AbortController(),
    waiting = model.doGenerate({ ...params, abortSignal: abort.signal });
  await ready;
  abort.abort();
  release();
  await expect(waiting).rejects.toThrow();
  expect(admit).toHaveBeenCalledTimes(1);
  expect(call).not.toHaveBeenCalled();
  expect(sink).not.toHaveBeenCalled();
});
it("a reservation is made for each real invocation and no refund occurs on provider failure", async () => {
  let remaining = 1;
  const error = Error("provider-failed"),
    call = vi.fn(async () => {
      throw error;
    }),
    sink = vi.fn();
  const admit = vi.fn(async () => {
    if (remaining-- <= 0) throw Error("exhausted");
  });
  const model = observeLanguage(
    new MockLanguageModelV2({ doGenerate: call }),
    base,
    sink,
    undefined,
    undefined,
    admit,
  );
  await expect(generateText({ model, prompt: "x", maxRetries: 0 })).rejects.toBe(error);
  await expect(generateText({ model, prompt: "x", maxRetries: 0 })).rejects.toThrow("exhausted");
  expect(call).toHaveBeenCalledTimes(1);
  expect(admit).toHaveBeenCalledTimes(2);
  expect(sink).toHaveBeenCalledTimes(1);
});
