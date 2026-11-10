import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { uuidv7 } from "uuidv7";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { createModelQuota, ModelQuotaError } from "../src/quota/repository.js";
import { createMeteredQwenReranker } from "../src/retrieval/metered-reranker.js";

let t: TestDb;
const model = "Qwen/Qwen3-Reranker-0.6B";
const project = uuidv7(),
  other = uuidv7(),
  conversation = uuidv7();
const scope = () => ({ projectId: project, conversationId: conversation });
const input = () => ({
  query: "private query",
  documents: [{ beliefVersionId: uuidv7(), content: "private content" }],
});
const response = (
  usage: unknown = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 20 },
) => ({ object: "list", model, data: [{ object: "score", index: 0, score: 0.9 }], usage });
const rows = () => t.sql`select * from model_usage where project_id=${project} order by id`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const config = () => ({ endpoint: "https://offline.invalid/score", apiKey: "offline-fake-secret" });
function setup(
  transport = vi.fn(async () => Response.json(response())),
  admit = vi.fn(async () => {}),
) {
  vi.stubGlobal("fetch", transport);
  return {
    transport,
    admit,
    client: createMeteredQwenReranker(t.db, config(), { admitModelCall: admit }),
  };
}
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${project},'metered reranker'),(${other},'other')`;
  await t.sql`insert into conversations(id,project_id) values(${conversation},${project})`;
}, 180000);
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await t.sql`delete from model_usage where project_id in (${project},${other})`;
});
afterAll(async () => {
  await t?.close();
});

it("real TCP score request reserves once and stores independent reported counts without body/credentials", async () => {
  const received: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response()));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const admit = vi.fn(async () => {});
  try {
    const client = createMeteredQwenReranker(
      t.db,
      { ...config(), endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/score` },
      { admitModelCall: admit },
    );
    const prepared = input();
    const result = await client.rerank(prepared, scope());
    expect(result.items).toEqual([
      { beliefVersionId: prepared.documents[0]!.beliefVersionId, score: 0.9, rank: 1 },
    ]);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual({
      model,
      text_1: prepared.query,
      text_2: ["private content"],
      use_activation: true,
    });
    const records = await rows();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      project_id: project,
      conversation_id: conversation,
      provider_name: "qwen-score-api",
      model_id: model,
      slot: "reranker",
      purpose: "rerank",
      status: "success",
      prompt_tokens: "12",
      completion_tokens: "3",
      total_tokens: "20",
      reasoning_tokens: null,
      cached_input_tokens: null,
    });
    expect(Number(records[0]!.duration_ms)).toBeGreaterThanOrEqual(0);
    for (const secret of [
      prepared.query,
      "private content",
      "offline-fake-secret",
      prepared.documents[0]!.beliefVersionId,
    ])
      expect(JSON.stringify(records)).not.toContain(secret);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it.each([
  undefined,
  null,
  {},
  { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
])("unknown/malformed usage stays null instead of estimated zero: %j", async (usage) => {
  const { client } = setup(vi.fn(async () => Response.json({ ...response(), usage })));
  await client.rerank(input(), { projectId: project, conversationId: null });
  const records = await rows();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    conversation_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  });
});
it("preserves explicitly reported zero counts", async () => {
  const { client } = setup(
    vi.fn(async () =>
      Response.json(response({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })),
    ),
  );
  await client.rerank(input(), scope());
  expect((await rows())[0]).toMatchObject({
    prompt_tokens: "0",
    completion_tokens: "0",
    total_tokens: "0",
  });
});
it.each([
  { projectId: other, conversationId: conversation },
  { projectId: uuidv7(), conversationId: null },
  { projectId: project, conversationId: uuidv7() },
  { projectId: "garbage", conversationId: null },
  { projectId: project, conversationId: null, key: "secret" },
  { projectId: project },
  null,
])("invalid/cross-project scope denies before quota or network: %j", async (value) => {
  const { client, admit, transport } = setup();
  await expect(client.rerank(input(), value)).rejects.toThrow("INVALID_RERANK_SCOPE");
  expect(admit).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(0);
});
it("invalid input, empty input and preabort make no reservations, requests or usage", async () => {
  const { client, admit, transport } = setup();
  await expect(client.rerank({ ...input(), query: "" }, scope())).rejects.toThrow(
    "INVALID_RERANK_INPUT",
  );
  await expect(
    client.rerank(input(), scope(), AbortSignal.abort("private reason")),
  ).rejects.toThrow("RERANK_ABORTED");
  await expect(client.rerank({ query: "q", documents: [] }, scope())).resolves.toEqual({
    model,
    items: [],
    usage: null,
  });
  expect(admit).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(0);
});
it("scope database failure fails closed before reservation and does not echo the exception", async () => {
  const broken = new Proxy(t.db, {
    get() {
      throw Error("private database failure");
    },
  });
  const transport = vi.fn(),
    admit = vi.fn(async () => {});
  vi.stubGlobal("fetch", transport);
  const client = createMeteredQwenReranker(broken, config(), { admitModelCall: admit });
  await expect(client.rerank(input(), scope())).rejects.toThrow(/^INVALID_RERANK_SCOPE$/);
  expect(admit).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
it("empty documents do not even query scope storage", async () => {
  const broken = new Proxy(t.db, {
      get() {
        throw Error("must not read");
      },
    }),
    admit = vi.fn();
  const client = createMeteredQwenReranker(broken, config(), { admitModelCall: admit });
  expect(await client.rerank({ query: "q", documents: [] }, scope())).toEqual({
    model,
    items: [],
    usage: null,
  });
  expect(admit).not.toHaveBeenCalled();
});
it("snapshots input, scope and dependency methods before awaiting quota", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const admit = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const transport = vi.fn<typeof fetch>(async () => Response.json(response()));
  vi.stubGlobal("fetch", transport);
  const options = { admitModelCall: admit };
  const client = createMeteredQwenReranker(t.db, config(), options);
  const prepared = input(),
    context = scope(),
    id = prepared.documents[0]!.beliefVersionId;
  const pending = client.rerank(prepared, context);
  await entered.promise;
  prepared.query = "changed";
  prepared.documents[0]!.content = "changed";
  prepared.documents[0]!.beliefVersionId = uuidv7();
  context.projectId = other;
  options.admitModelCall = vi.fn(async () => {
    throw Error("changed");
  });
  release.resolve();
  expect((await pending).items[0]?.beliefVersionId).toBe(id);
  expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toMatchObject({
    text_1: "private query",
    text_2: ["private content"],
  });
  expect((await rows())[0]).toMatchObject({ project_id: project, conversation_id: conversation });
});
it("cancel during admission consumes no provider invocation/usage even if admission later completes", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const abort = new AbortController();
  const { client, transport, admit } = setup(
    undefined,
    vi.fn(async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  const waiting = client.rerank(input(), scope(), abort.signal);
  await entered.promise;
  abort.abort("private reason");
  release.resolve();
  await expect(waiting).rejects.toThrow(/^RERANK_ABORTED$/);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(0);
});
it.each(["exhausted", "unavailable"] as const)(
  "preserves typed quota denial %s and makes zero phantom usage",
  async (reason) => {
    const denial = new ModelQuotaError(reason, 60);
    const { client, transport } = setup(
      undefined,
      vi.fn(async () => {
        throw denial;
      }),
    );
    await expect(client.rerank(input(), scope())).rejects.toBe(denial);
    expect(transport).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  },
);
it("unknown admission failure has a fixed safe error with zero provider calls", async () => {
  const { client, transport } = setup(
    undefined,
    vi.fn(async () => {
      throw Error("private quota error");
    }),
  );
  await expect(client.rerank(input(), scope())).rejects.toThrow(/^RERANK_ADMISSION_FAILED$/);
  expect(transport).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(0);
});
it.each(["transport", "invalid", "timeout", "abort"])(
  "a %s outcome makes one reservation, one request and one safe error/aborted record",
  async (outcome) => {
    const abort = new AbortController(),
      entered = deferred<void>();
    const transport = vi.fn(async () => {
      entered.resolve();
      if (outcome === "transport") throw Error("private provider error");
      if (outcome === "invalid") return Response.json({ private: "secret" });
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", transport);
    const admit = vi.fn(async () => {}),
      client = createMeteredQwenReranker(
        t.db,
        { ...config(), timeoutMs: 50 },
        { admitModelCall: admit },
      );
    const pending = client.rerank(input(), scope(), abort.signal);
    const checked = expect(pending).rejects.toThrow(
      outcome === "abort"
        ? "RERANK_ABORTED"
        : outcome === "timeout"
          ? "RERANK_TIMEOUT"
          : outcome === "invalid"
            ? "RERANK_INVALID_RESPONSE"
            : "RERANK_FAILED",
    );
    await entered.promise;
    if (outcome === "abort") abort.abort("private cancellation");
    await checked;
    expect(admit).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    const records = await rows();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: outcome === "abort" ? "aborted" : "error",
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
    });
    expect(JSON.stringify(records)).not.toMatch(/private|secret/);
  },
);
it("actual quota reserves two attempts, never refunds a failed score call and rejects the third before transport", async () => {
  // One connection owns its temporary counter; the user's/shared public quota is never changed.
  const connection = postgres(t.url, { max: 1 });
  try {
    await connection`create temporary table model_daily_quota(day date primary key,calls bigint not null)`;
    const admission = createModelQuota(drizzle(connection), 2);
    const transport = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", transport);
    const client = createMeteredQwenReranker(t.db, config(), { admitModelCall: admission });
    await expect(client.rerank(input(), scope())).rejects.toThrow("RERANK_FAILED");
    await expect(client.rerank(input(), scope())).rejects.toThrow("RERANK_FAILED");
    await expect(client.rerank(input(), scope())).rejects.toMatchObject({
      reason: "exhausted",
      statusCode: 429,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(2);
    const [counter] = await connection`select calls from model_daily_quota`;
    expect(counter?.calls).toBe("2");
  } finally {
    await connection.end();
  }
});
it.each(["success", "error"])(
  "failed usage insert/logger preserves the %s outcome without retry",
  async (outcome) => {
    const constraint = `test_rerank_${project.replaceAll("-", "")}`;
    await t.sql.unsafe(
      `alter table model_usage add constraint ${constraint} check (project_id <> '${project}') not valid`,
    );
    const warn = vi.fn(() => {
        throw Error("private logger");
      }),
      transport = vi.fn(async () =>
        outcome === "success" ? Response.json(response()) : new Response(null, { status: 503 }),
      );
    vi.stubGlobal("fetch", transport);
    try {
      const admit = vi.fn(async () => {}),
        client = createMeteredQwenReranker(t.db, config(), {
          admitModelCall: admit,
          usageLogger: { warn },
        });
      if (outcome === "success")
        expect((await client.rerank(input(), scope())).items).toHaveLength(1);
      else await expect(client.rerank(input(), scope())).rejects.toThrow(/^RERANK_FAILED$/);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(await rows()).toHaveLength(0);
      expect(warn.mock.calls).toEqual([["model usage persistence failed"]]);
    } finally {
      await t.sql.unsafe(`alter table model_usage drop constraint ${constraint}`);
    }
  },
);
it("requires an explicit admission function at construction", () => {
  expect(() =>
    createMeteredQwenReranker(t.db, config(), { admitModelCall: undefined as never }),
  ).toThrow("INVALID_RERANK_OBSERVER_CONFIG");
});

it("scope getters cannot leak arbitrary exceptions before admission", async () => {
  const { client, admit, transport } = setup();
  const value = {
    get projectId() {
      throw Error("private getter secret");
    },
    conversationId: null,
  };
  await expect(client.rerank(input(), value)).rejects.toThrow(/^INVALID_RERANK_SCOPE$/);
  expect(admit).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(0);
});

it("one multi-document score batch still produces only one reservation and usage row", async () => {
  const prepared = input();
  prepared.documents.push({ beliefVersionId: uuidv7(), content: "second content" });
  const transport = vi.fn(async () =>
    Response.json({
      ...response(),
      data: [
        { object: "score", index: 1, score: 0.95 },
        { object: "score", index: 0, score: 0.1 },
      ],
    }),
  );
  const { client, admit } = setup(transport);
  const result = await client.rerank(prepared, scope());
  expect(result.items.map((i) => i.beliefVersionId)).toEqual([
    prepared.documents[1]!.beliefVersionId,
    prepared.documents[0]!.beliefVersionId,
  ]);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await rows()).toHaveLength(1);
});
