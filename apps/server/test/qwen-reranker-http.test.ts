import { expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createQwenReranker } from "../src/retrieval/qwen-reranker.js";

const model = "Qwen/Qwen3-Reranker-0.6B";
const a = "01900000-0000-7000-8000-000000000001",
  b = "01900000-0000-7000-8000-000000000002";
const input = () => ({
  query: "database?",
  documents: [
    { beliefVersionId: a, content: "SQLite" },
    { beliefVersionId: b, content: "PostgreSQL" },
  ],
});
const result = () => ({
  object: "list",
  model,
  data: [
    { index: 0, object: "score", score: 0.1 },
    { index: 1, object: "score", score: 0.9 },
  ],
  usage: { prompt_tokens: 17, total_tokens: 17 },
});
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${(s.address() as AddressInfo).port}/score`,
    close: async () => {
      s.closeAllConnections();
      await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
function json(res: ServerResponse, value: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

it("real TCP POST implements single-query/batch-score protocol with no IDs or extra credential sources", async () => {
  const seen: { url: string | undefined; auth: string | undefined; body: string }[] = [];
  const s = await server((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      json(res, result());
    });
  });
  try {
    const client = createQwenReranker({ endpoint: s.endpoint, apiKey: "offline-fake-rerank-key" });
    const r = await client.rerank(input());
    expect(r.items.map((c) => c.beliefVersionId)).toEqual([b, a]);
    expect(r.usage).toEqual({ inputTokens: 17, outputTokens: null, totalTokens: 17 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/score", auth: "Bearer offline-fake-rerank-key" });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      model,
      text_1: "database?",
      text_2: ["SQLite", "PostgreSQL"],
      use_activation: true,
    });
    expect(seen[0]!.body).not.toContain(a);
  } finally {
    await s.close();
  }
});
it("parallel calls have isolated request identities even when responses complete in reverse order", async () => {
  let release!: () => void;
  const both = new Promise<void>((r) => {
      release = r;
    }),
    pending: { res: ServerResponse; query: string }[] = [];
  const s = await server((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      pending.push({ res, query: JSON.parse(body).text_1 });
      if (pending.length === 2) release();
    });
  });
  try {
    const client = createQwenReranker({ endpoint: s.endpoint });
    const first = client.rerank({ ...input(), query: "first" }),
      second = client.rerank({
        ...input(),
        query: "second",
        documents: input().documents.slice().reverse(),
      });
    await both;
    for (const p of pending.slice().reverse())
      json(p.res, {
        ...result(),
        data: [
          { index: 0, object: "score", score: 1 },
          { index: 1, object: "score", score: 0 },
        ],
      });
    expect((await first).items[0]!.beliefVersionId).toBe(a);
    expect((await second).items[0]!.beliefVersionId).toBe(b);
    expect(new Set(pending.map((p) => p.query))).toEqual(new Set(["first", "second"]));
  } finally {
    await s.close();
  }
});
it("native fetch never follows a redirect with candidate content or authorization", async () => {
  let targetCalls = 0,
    sourceCalls = 0;
  const target = await server((_req, res) => {
    targetCalls++;
    json(res, result());
  });
  const source = await server((_req, res) => {
    sourceCalls++;
    res.writeHead(307, { location: target.endpoint });
    res.end();
  });
  try {
    await expect(
      createQwenReranker({ endpoint: source.endpoint, apiKey: "offline-private-key" }).rerank(
        input(),
      ),
    ).rejects.toThrow(/^RERANK_FAILED$/);
    expect(sourceCalls).toBe(1);
    expect(targetCalls).toBe(0);
  } finally {
    await source.close();
    await target.close();
  }
});
it("real HTTP503 remains one invocation and does not expose body/header secrets", async () => {
  let calls = 0;
  const s = await server((_req, res) => {
    calls++;
    res.writeHead(503, { "x-private": "private" });
    res.end("sk-upstream-private");
  });
  try {
    const error = await createQwenReranker({ endpoint: s.endpoint })
      .rerank(input())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ message: "RERANK_FAILED" });
    expect(error).not.toHaveProperty("cause");
    expect(calls).toBe(1);
  } finally {
    await s.close();
  }
});
it("caller cancellation closes a real partial response without using its unfinished JSON", async () => {
  let ready!: () => void, closed!: () => void;
  const entered = new Promise<void>((r) => {
      ready = r;
    }),
    disconnected = new Promise<void>((r) => {
      closed = r;
    });
  const s = await server((_req, res) => {
    res.on("close", closed);
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"object":"list","data":[');
    ready();
  });
  try {
    const c = new AbortController(),
      p = createQwenReranker({ endpoint: s.endpoint }).rerank(input(), c.signal);
    await entered;
    c.abort("sk-private-reason");
    await expect(p).rejects.toThrow(/^RERANK_ABORTED$/);
    await disconnected;
  } finally {
    await s.close();
  }
});
it("a real stalled response remains subject to the adapter deadline", async () => {
  const s = await server((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  try {
    await expect(
      createQwenReranker({ endpoint: s.endpoint, timeoutMs: 100 }).rerank(input()),
    ).rejects.toThrow(/^RERANK_TIMEOUT$/);
  } finally {
    await s.close();
  }
});
it("chunked response size is limited by actual decoded bytes, not absent Content-Length", async () => {
  const s = await server((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(" ".repeat(128 * 1024));
    res.end(" ".repeat(129 * 1024));
  });
  try {
    await expect(createQwenReranker({ endpoint: s.endpoint }).rerank(input())).rejects.toThrow(
      /^RERANK_INVALID_RESPONSE$/,
    );
  } finally {
    await s.close();
  }
});
it("UTF8 split across transport chunks is decoded as one complete JSON response", async () => {
  const s = await server((_req, res) => {
    const bytes = Buffer.from(JSON.stringify({ ...result(), ignored: "中文" })),
      split = bytes.indexOf(Buffer.from("中")) + 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.write(bytes.subarray(0, split));
    res.end(bytes.subarray(split));
  });
  try {
    expect(
      (await createQwenReranker({ endpoint: s.endpoint }).rerank(input())).items.map(
        (c) => c.beliefVersionId,
      ),
    ).toEqual([b, a]);
  } finally {
    await s.close();
  }
});
