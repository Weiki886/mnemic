import { expect, it, vi } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { uuidv7 } from "uuidv7";
import { observeLanguage } from "../src/usage/models.js";
import { createModelDebug, type ModelContentRecord } from "../src/debug/model-content.js";
const base = {
  projectId: uuidv7(),
  conversationId: uuidv7(),
  providerName: "local",
  modelId: "chat",
  slot: "chat" as const,
  purpose: "chat" as const,
};
const key = "opaque-model-debug-credential-012345678901";
const params = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: `user ${key}` }] }],
};
const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
const result = () => ({
  content: [{ type: "text" as const, text: `answer ${key}` }],
  finishReason: "stop" as const,
  usage,
  warnings: [],
});
type Part =
  Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer T>
    ? T
    : never;
function capture() {
  const rows: ModelContentRecord[] = [];
  const factory = createModelDebug({ debug: (r) => rows.push(r) })(
    {
      project_id: base.projectId,
      conversation_id: base.conversationId,
      evidence_id: uuidv7(),
      provider_name: "local",
      model_id: "chat",
      slot: "chat",
    },
    key,
  )!;
  return { rows, factory };
}
it("observes actual generate attempts before parsing without mutating model inputs or results", async () => {
  const f = capture(),
    paid = vi.fn(async () => result());
  const model = observeLanguage(
    new MockLanguageModelV2({ doGenerate: paid }),
    base,
    async () => {},
    undefined,
    f.factory,
  );
  expect((await model.doGenerate(params)).content).toEqual(result().content);
  expect(f.rows).toHaveLength(2);
  expect(f.rows[0]!.detail).toMatchObject({
    content: [{ role: "user", content: [{ type: "text", text: "user [REDACTED]" }] }],
  });
  expect(f.rows[1]!.detail.content).toEqual([{ type: "text", text: "answer [REDACTED]" }]);
  expect(paid.mock.calls).toHaveLength(1);
  expect(params.prompt[0]!.content[0]!.text).toContain(key);
});
it("Repeated invocations have distinct paired capture IDs; exceptions and logging failures never cause replays", async () => {
  const f = capture();
  let n = 0;
  const error = new Error(key);
  const model = observeLanguage(
    new MockLanguageModelV2({
      doGenerate: async () => {
        if (++n === 1) throw error;
        return result();
      },
    }),
    base,
    async () => {},
    undefined,
    f.factory,
  );
  await expect(model.doGenerate(params)).rejects.toBe(error);
  await model.doGenerate(params);
  expect(f.rows.map((r) => r.event)).toEqual([
    "model.prompt",
    "model.response",
    "model.prompt",
    "model.response",
  ]);
  expect(f.rows[0]!.target_id).toBe(f.rows[1]!.target_id);
  expect(f.rows[2]!.target_id).toBe(f.rows[3]!.target_id);
  expect(f.rows[0]!.target_id).not.toBe(f.rows[2]!.target_id);
  expect(f.rows[1]!.detail).toMatchObject({ status: "error", content: null });
  expect(JSON.stringify(f.rows)).not.toContain(key);
  const paid = vi.fn(async () => result());
  const broken = observeLanguage(
    new MockLanguageModelV2({ doGenerate: paid }),
    base,
    async () => {},
    undefined,
    () => {
      throw error;
    },
  );
  expect((await generateText({ model: broken, prompt: "x" })).text).toContain(key);
  expect(paid).toHaveBeenCalledTimes(1);
});
it("stream preserves backpressure and chunks, completes once and redacts only after EOF", async () => {
  const f = capture();
  let pulls = 0;
  const parts: Part[] = [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: key.slice(0, 11) },
    { type: "text-delta", id: "t", delta: key.slice(11) },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage },
  ];
  const model = observeLanguage(
    new MockLanguageModelV2({
      doStream: async () => ({
        stream: new ReadableStream<Part>(
          {
            pull(c) {
              const part = parts[pulls++];
              if (part) c.enqueue(part);
              else c.close();
            },
          },
          { highWaterMark: 0 },
        ),
      }),
    }),
    base,
    async () => {},
    undefined,
    f.factory,
  );
  const stream = await model.doStream(params);
  await Promise.resolve();
  expect(pulls).toBeLessThanOrEqual(1);
  expect(f.rows).toHaveLength(1);
  const received: Part[] = [];
  for await (const p of stream.stream) received.push(p);
  expect(received).toEqual(parts);
  expect(f.rows[1]!.detail.content).toEqual([{ type: "text", text: "[REDACTED]" }]);
});
it.each(["error-frame", "eof", "open-error"])(
  "omits partial output for %s without serializing exceptions",
  async (mode) => {
    const f = capture();
    const model = observeLanguage(
      new MockLanguageModelV2({
        doStream: async () => {
          if (mode === "open-error") throw new Error(key);
          return {
            stream: new ReadableStream<Part>({
              start(c) {
                c.enqueue({ type: "text-start", id: "t" });
                c.enqueue({ type: "text-delta", id: "t", delta: key.slice(0, 10) });
                if (mode === "error-frame") c.enqueue({ type: "error", error: new Error(key) });
                c.close();
              },
            }),
          };
        },
      }),
      base,
      async () => {},
      undefined,
      f.factory,
    );
    if (mode === "open-error") await expect(model.doStream(params)).rejects.toThrow(key);
    else {
      const r = await model.doStream(params);
      for await (const _ of r.stream) {
        /* consume */
      }
    }
    expect(f.rows[1]!.detail).toMatchObject({ status: "error", content: null, complete: false });
    expect(JSON.stringify(f.rows)).not.toContain(key.slice(0, 10));
  },
);
it("abort and cancel finalize once, omit content and immediately forward upstream cancellation", async () => {
  const f = capture(),
    abort = new AbortController(),
    cancelled = vi.fn();
  let release!: () => void;
  const slow = new Promise<void>((r) => {
    release = r;
  });
  const model = observeLanguage(
    new MockLanguageModelV2({
      doStream: async () => ({ stream: new ReadableStream<Part>({ cancel: cancelled }) }),
    }),
    base,
    () => slow,
    undefined,
    f.factory,
  );
  const { stream } = await model.doStream({ ...params, abortSignal: abort.signal });
  abort.abort();
  const end = stream.cancel();
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(f.rows).toHaveLength(2);
    expect(f.rows[1]!.detail).toMatchObject({ status: "aborted", content: null });
  } finally {
    release();
    await end;
  }
});
it("already aborted has zero capture calls or provider calls; disabled observer never inspects prompt for logging", async () => {
  const f = capture(),
    begin = vi.fn(f.factory),
    paid = vi.fn(async () => result());
  const model = observeLanguage(
    new MockLanguageModelV2({ doGenerate: paid }),
    base,
    async () => {},
    undefined,
    begin,
  );
  await expect(model.doGenerate({ ...params, abortSignal: AbortSignal.abort() })).rejects.toThrow();
  expect(begin).not.toHaveBeenCalled();
  expect(paid).not.toHaveBeenCalled();
  const off = observeLanguage(new MockLanguageModelV2({ doGenerate: paid }), base, async () => {});
  const trap = new Proxy(params.prompt, {
    get() {
      throw Error("prompt inspected");
    },
  });
  await off.doGenerate({ prompt: trap });
  expect(paid).toHaveBeenCalledOnce();
});
