import { afterEach, expect, it, vi } from "vitest";
import { createQwenReranker } from "../src/retrieval/qwen-reranker.js";

const model = "Qwen/Qwen3-Reranker-0.6B";
const a = "01900000-0000-7000-8000-00000000000a",
  b = "01900000-0000-7000-8000-00000000000b";
const input = () => ({
  query: "数据库选型？",
  documents: [
    { beliefVersionId: a, content: " PostgreSQL\n" },
    { beliefVersionId: b, content: "SQLite" },
  ],
});
const wire = () => ({
  id: "untrusted-upstream-id",
  object: "list",
  model,
  data: [
    { index: 1, object: "score", score: 0.9 },
    { index: 0, object: "score", score: 0.2 },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 17 },
});
const make = (extra = {}) =>
  createQwenReranker({ endpoint: "https://reranker.example/score", ...extra });
const fetcher = (value: unknown = wire()) => {
  const fn = vi.fn(async () => Response.json(value));
  vi.stubGlobal("fetch", fn);
  return fn;
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("does not reuse the server Bearer credential when no reranker API key was supplied", async () => {
  vi.stubEnv("MNEMIC_AUTH_TOKEN", "offline-server-token-is-not-a-reranker-key");
  const fn = fetcher();
  await make().rerank(input());
  const [, options] = (fn.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(new Headers(options.headers).has("authorization")).toBe(false);
});

it("accepts the exact UTF8 text budget and does not silently truncate whole documents", async () => {
  const documents = [16384, 16384, 16384, 8192].map((length, i) => ({
    beliefVersionId: `01900000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    content: "x".repeat(length),
  }));
  const fn = fetcher({
    ...wire(),
    data: documents.map((_, index) => ({ index, object: "score", score: 0.5 })),
  });
  const r = await make().rerank({ query: "q".repeat(8192), documents });
  expect(r.items).toHaveLength(4);
  const [, options] = (fn.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(JSON.parse(options.body as string).text_2).toEqual(documents.map((d) => d.content));
});

it("supports exactly200 distinct input identities and a complete indexed response", async () => {
  const documents = Array.from({ length: 200 }, (_, i) => ({
    beliefVersionId: `01900000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    content: "x",
  }));
  fetcher({
    ...wire(),
    data: documents.map((_, index) => ({ index, object: "score", score: 0.5 })).reverse(),
  });
  const r = await make().rerank({ query: "q", documents });
  expect(r.items.map((x) => x.beliefVersionId)).toEqual(documents.map((d) => d.beliefVersionId));
  expect(r.items.at(-1)!.rank).toBe(200);
});

it("uses the verified score protocol, does not send IDs, sorts indexed scores and projects usage without inventing totals", async () => {
  const fetch = fetcher(),
    client = make({ apiKey: "offline-private-key" });
  const r = await client.rerank(input());
  expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(url).toBe("https://reranker.example/score");
  expect(options).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { authorization: "Bearer offline-private-key", "content-type": "application/json" },
  });
  expect(JSON.parse(options.body as string)).toEqual({
    model,
    text_1: "数据库选型？",
    text_2: [" PostgreSQL\n", "SQLite"],
    use_activation: true,
  });
  expect(r).toEqual({
    model,
    items: [
      { beliefVersionId: b, score: 0.9, rank: 1 },
      { beliefVersionId: a, score: 0.2, rank: 2 },
    ],
    usage: { inputTokens: 20, outputTokens: 0, totalTokens: 17 },
  });
  expect(JSON.stringify(r)).not.toContain("private");
  expect(JSON.stringify(r)).not.toContain("PostgreSQL");
});
it("equal scores retain the upstream candidate order and endpoints/proxy metadata never become results", async () => {
  fetcher({
    ...wire(),
    data: [
      { index: 1, object: "score", score: 0.4, document: "sk-secret" },
      { index: 0, object: "score", score: 0.4 },
    ],
    api_key: "sk-private",
    endpoint: "https://private",
  });
  const r = await make().rerank(input());
  expect(r.items.map((x) => x.beliefVersionId)).toEqual([a, b]);
  expect(JSON.stringify(r)).not.toMatch(/private|secret|endpoint|document/);
});
it.each([
  undefined,
  null,
  {},
  { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: "5" },
  { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
])("unknown token usage %# stays unknown, never summed or assumed free", async (usage) => {
  fetcher({ ...wire(), usage });
  const r = await make().rerank(input());
  expect(r.usage).toEqual(
    usage && typeof usage === "object"
      ? { inputTokens: null, outputTokens: null, totalTokens: null }
      : null,
  );
});
it.each([
  null,
  {},
  { endpoint: "ftp://reranker.example/score" },
  { endpoint: "http://reranker.example/score" },
  { endpoint: "https://user:private@reranker.example/score" },
  { endpoint: "https://reranker.example/score?key=private" },
  { endpoint: "https://reranker.example/score#private" },
  { endpoint: "https://reranker.example/v1/chat/completions" },
  { endpoint: " https://reranker.example/score" },
  { endpoint: "https://reranker.example/score", extra: true },
  { endpoint: "https://reranker.example/sc\nore" },
  { endpoint: "https://reranker.example/score?" },
  { endpoint: "https://reranker.example/score", apiKey: "private\nheader" },
  ...[0, 30001, 1.5, "5"].map((timeoutMs) => ({
    endpoint: "https://reranker.example/score",
    timeoutMs,
  })),
])("invalid transport configuration %# fails safely without network access", (options) => {
  const fetch = fetcher();
  expect(() => createQwenReranker(options)).toThrow(/^INVALID_RERANK_CONFIG$/);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  "http://127.0.0.1:8000/score",
  "http://[::1]:8000/score",
  "http://localhost:8000/score",
  "https://reranker.example/v1/score",
])("accepts operator endpoint %s without automatically contacting it", (endpoint) => {
  const fetch = fetcher();
  expect(createQwenReranker({ endpoint }).model).toBe(model);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { ...input(), extra: true },
  { ...input(), query: " " },
  { ...input(), query: "bad\0query" },
  { ...input(), query: "\ud800" },
  { ...input(), query: "x".repeat(8193) },
  { ...input(), query: "中".repeat(2731) },
  { ...input(), documents: [{ beliefVersionId: "bad", content: "safe" }] },
  { ...input(), documents: [{ beliefVersionId: a, content: "" }] },
  { ...input(), documents: [{ beliefVersionId: a, content: "x".repeat(16385) }] },
  { ...input(), documents: [{ beliefVersionId: a, content: "中".repeat(5462) }] },
  { ...input(), documents: [{ beliefVersionId: a, content: "\ud800" }] },
  { ...input(), documents: [{ beliefVersionId: a, content: "bad\0text" }] },
  { ...input(), documents: [{ beliefVersionId: a, content: "safe", key: "private" }] },
  {
    ...input(),
    documents: [
      { beliefVersionId: a, content: "one" },
      { beliefVersionId: a.toUpperCase(), content: "two" },
    ],
  },
  {
    ...input(),
    documents: Array.from({ length: 5 }, (_, i) => ({
      beliefVersionId: `01900000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      content: "x".repeat(16384),
    })),
  },
])("invalid ranking input %# is rejected before any external invocation", async (value) => {
  const fetch = fetcher();
  await expect(make().rerank(value)).rejects.toThrow(/^INVALID_RERANK_INPUT$/);
  expect(fetch).not.toHaveBeenCalled();
});
it("guards document count before traversing a hostile oversized collection", async () => {
  const documents = new Proxy(new Array(1000000), {
    get(t, k) {
      if (k === "0") throw Error("must not inspect");
      return Reflect.get(t, k);
    },
  });
  const fetch = fetcher();
  await expect(make().rerank({ query: "q", documents })).rejects.toThrow(/^INVALID_RERANK_INPUT$/);
  expect(fetch).not.toHaveBeenCalled();
});
it("empty candidates never invoke a model or fabricate token usage", async () => {
  const fetch = fetcher();
  expect(await make().rerank({ query: "query", documents: [] })).toEqual({
    model,
    items: [],
    usage: null,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { ...wire(), model: "some-other-model" },
  { ...wire(), object: "error" },
  { ...wire(), data: [] },
  {
    ...wire(),
    data: [
      { index: 0, object: "score", score: 1 },
      { index: 0, object: "score", score: 0 },
    ],
  },
  {
    ...wire(),
    data: [
      { index: 0, object: "score", score: 1 },
      { index: 2, object: "score", score: 0 },
    ],
  },
  {
    ...wire(),
    data: [
      { index: 0.5, object: "score", score: 1 },
      { index: 1, object: "score", score: 0 },
    ],
  },
  ...[-0.1, 1.1, "0.5", null].map((score) => ({
    ...wire(),
    data: [
      { index: 0, object: "score", score },
      { index: 1, object: "score", score: 0 },
    ],
  })),
  {
    ...wire(),
    data: [
      { index: 0, object: "embedding", score: 1 },
      { index: 1, object: "score", score: 0 },
    ],
  },
])(
  "bad upstream response %# fails the entire batch, never returning partial scores",
  async (value) => {
    const fetch = fetcher(value);
    await expect(make().rerank(input())).rejects.toThrow(/^RERANK_INVALID_RESPONSE$/);
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it("rejects oversized response row cardinality as one batch failure", async () => {
  // JSON bytes are bounded separately; this checks cardinality before per-row Zod validation.
  fetcher({ ...wire(), data: new Array(201).fill(null) });
  await expect(make().rerank(input())).rejects.toThrow(/^RERANK_INVALID_RESPONSE$/);
});
it("copies identities/content/config and pins transport before the first wait", async () => {
  let release!: (r: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const config = { endpoint: "https://reranker.example/score", apiKey: "original" },
    data = input(),
    client = createQwenReranker(config);
  const promise = client.rerank(data);
  config.endpoint = "https://evil.example/score";
  config.apiKey = "changed";
  data.documents[0]!.beliefVersionId = b;
  data.documents[0]!.content = "changed";
  data.query = "changed";
  vi.stubGlobal("fetch", () => {
    throw Error("replacement transport");
  });
  release(Response.json(wire()));
  expect((await promise).items[1]!.beliefVersionId).toBe(a);
  const [url, options] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(url).toBe("https://reranker.example/score");
  expect(JSON.parse(options.body as string).text_2[0]).toBe(" PostgreSQL\n");
});
it("pre-cancelled calls perform zero HTTP requests and do not expose arbitrary abort reasons", async () => {
  const fetch = fetcher(),
    controller = new AbortController();
  controller.abort(Error("sk-private"));
  await expect(make().rerank(input(), controller.signal)).rejects.toThrow(/^RERANK_ABORTED$/);
  expect(fetch).not.toHaveBeenCalled();
});
it("mid-flight abort rejects promptly even when a transport ignores AbortSignal; late rejection is handled", async () => {
  let reject!: (e: Error) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((_, r) => {
        reject = r;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const c = new AbortController(),
    promise = make().rerank(input(), c.signal);
  c.abort("sk-private");
  await expect(promise).rejects.toThrow(/^RERANK_ABORTED$/);
  reject(Error("late sk-private transport"));
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledOnce();
});
it("HTTP and transport failures neither retry nor forward upstream secrets or causes", async () => {
  const fn = vi.fn(async () => new Response("sk-upstream-private", { status: 503 }));
  vi.stubGlobal("fetch", fn);
  await expect(make().rerank(input())).rejects.toThrow(/^RERANK_FAILED$/);
  expect(fn).toHaveBeenCalledOnce();
  fn.mockRejectedValueOnce(Error("sk-fetch-private"));
  const error = await make()
    .rerank(input())
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ message: "RERANK_FAILED" });
  expect(error).not.toHaveProperty("cause");
  expect(fn).toHaveBeenCalledTimes(2);
});
it("rejects invalid UTF8, oversized declared bodies and oversized chunked bodies with no partial output", async () => {
  const values = [
    new Response(new Uint8Array([255, 254]), { headers: { "content-type": "application/json" } }),
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": String(256 * 1024 + 1) },
    }),
    new Response(" ".repeat(256 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  ];
  const fn = vi.fn();
  vi.stubGlobal("fetch", fn);
  for (const r of values) {
    fn.mockResolvedValueOnce(r);
    await expect(make().rerank(input())).rejects.toThrow(/^RERANK_INVALID_RESPONSE$/);
  }
  expect(fn).toHaveBeenCalledTimes(3);
});
it("a body stream that fails after a JSON prefix never produces success", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"data":'));
            c.error(Error("sk-body-private"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await expect(make().rerank(input())).rejects.toThrow(/^RERANK_FAILED$/);
});
it("one monotonic deadline rejects a late header result even before the timeout callback can run", async () => {
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    vi.stubGlobal("fetch", async () => {
      clock = 100;
      return Response.json(wire());
    });
    await expect(make({ timeoutMs: 50 }).rerank(input())).rejects.toThrow(/^RERANK_TIMEOUT$/);
  } finally {
    now.mockRestore();
  }
});
it("a stalled transport times out instead of keeping the caller pending forever", async () => {
  const fn = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fn);
  await expect(make({ timeoutMs: 20 }).rerank(input())).rejects.toThrow(/^RERANK_TIMEOUT$/);
  expect(fn).toHaveBeenCalledOnce();
});
it("aborting a stalled body cancels its reader without awaiting hostile cleanup", async () => {
  let entered!: () => void;
  const read = new Promise<void>((r) => {
      entered = r;
    }),
    cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        entered();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  vi.stubGlobal(
    "fetch",
    async () => new Response(body, { headers: { "content-type": "application/json" } }),
  );
  const c = new AbortController(),
    promise = make().rerank(input(), c.signal);
  await read;
  c.abort(Error("sk-abort-private"));
  await expect(promise).rejects.toThrow(/^RERANK_ABORTED$/);
  expect(cancel).toHaveBeenCalledOnce();
});
it("cancels a late response from an uncooperative transport after caller cancellation", async () => {
  let release!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const c = new AbortController(),
    promise = make().rerank(input(), c.signal);
  c.abort();
  await expect(promise).rejects.toThrow(/^RERANK_ABORTED$/);
  const cancel = vi.fn();
  release(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
  await Promise.resolve();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
});

it("the deadline also covers an uncooperative body after HTTP headers have succeeded", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(new ReadableStream({ pull() {}, cancel }, { highWaterMark: 0 }), {
        headers: { "content-type": "application/json" },
      }),
  );
  await expect(make({ timeoutMs: 20 }).rerank(input())).rejects.toThrow(/^RERANK_TIMEOUT$/);
  expect(cancel).toHaveBeenCalledOnce();
});

it("accepts valid UTF8 even when a reader returns a multibyte character in separate chunks", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...wire(), ignored: "中文" }));
  const split = Buffer.from(bytes).indexOf(Buffer.from("中")) + 1;
  const chunks = [bytes.slice(0, split), bytes.slice(split)];
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              const next = chunks.shift();
              if (next) c.enqueue(next);
              else c.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  );
  expect((await make().rerank(input())).items.map((x) => x.beliefVersionId)).toEqual([b, a]);
});
