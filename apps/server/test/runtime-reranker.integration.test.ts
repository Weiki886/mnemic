import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { uuidv7 } from "uuidv7";
import { DEFAULT_FEATURE_FLAGS, createFeatureFlagSnapshot } from "@mnemic/shared/flags";
import { retrieve, type RetrieveOptions } from "../src/retrieval/search.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { durableModels } from "./fixtures/durable-models.js";
import { createProvider } from "../src/providers/repository.js";
import { ModelQuotaError } from "../src/quota/repository.js";
import { buildApp } from "../src/app.js";

let t: TestDb, endpoint: string;
const p = uuidv7(),
  other = uuidv7(),
  conv = uuidv7(),
  foreignConv = uuidv7(),
  message = uuidv7(),
  foreignMessage = uuidv7();
const model = durableModels(),
  providerName = `rerank-${uuidv7()}`,
  qwen = "Qwen/Qwen3-Reranker-0.6B";
const fusion = { mode: "rrf", threshold: 0.001 };
const snapshot = (extra = {}) =>
  createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 12,
    flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, reranker: true, ...extra },
  });
const admit = vi.fn(async () => {});
type Wire = { model: string; text_1: string; text_2: string[] };
let seen: Wire[] = [],
  handler: ((wire: Wire, res: ServerResponse) => void) | undefined;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (b) => {
    body += b;
  });
  req.on("end", () => {
    const wire = JSON.parse(body) as Wire;
    seen.push(wire);
    if (handler) {
      handler(wire, res);
      return;
    }
    json(res, {
      object: "list",
      model: qwen,
      data: wire.text_2.map((_, i) => ({
        object: "score",
        index: i,
        score: (i + 1) / (wire.text_2.length + 1),
      })),
      usage: { prompt_tokens: 9, total_tokens: 13 },
    });
  });
});
const json = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const opts = (extra: Partial<RetrieveOptions> = {}) => ({
  providerName,
  factory: model.factory,
  flagsSnapshot: snapshot(),
  fusion,
  topK: 1,
  reranker: { endpoint, apiKey: "offline-rerank-private" },
  admitModelCall: admit,
  usageContext: { projectId: p, conversationId: conv, purpose: "chat" as const },
  ...extra,
});
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${p},'runtime reranker'),(${other},'foreign')`;
  await t.sql`insert into conversations(id,project_id) values(${conv},${p}),(${foreignConv},${other})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${message},${conv},'user','offline',now()),(${foreignMessage},${foreignConv},'user','offline',now())`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: providerName,
    protocol: "openai-compatible",
    baseUrl: "https://offline.invalid",
    apiKey: "offline",
    models: { embedding: "embed" },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/score`;
}, 180000);
afterEach(async () => {
  handler = undefined;
  seen = [];
  admit.mockReset();
  admit.mockResolvedValue(undefined);
  model.embedding.mockClear();
  vi.restoreAllMocks();
  await t.sql`delete from retrieval_traces where project_id=${p}`;
  await t.sql`delete from model_usage where project_id in (${p},${other})`;
  await t.sql`update beliefs set current_version_id=null where project_id in (${p},${other})`;
  await t.sql`delete from memory_embeddings where belief_version_id in (select v.id from belief_versions v join beliefs b on b.id=v.belief_id where b.project_id in (${p},${other}))`;
  await t.sql`delete from belief_versions where belief_id in (select id from beliefs where project_id in (${p},${other}))`;
  await t.sql`delete from beliefs where project_id in (${p},${other})`;
  await t.sql`delete from observations where project_id in (${p},${other})`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  if (t) {
    await t.sql`delete from provider_configs where name=${providerName}`;
    await t.sql`delete from messages where conversation_id in (${conv},${foreignConv})`;
    await t.sql`delete from conversations where project_id in (${p},${other})`;
    await t.sql`delete from projects where id in (${p},${other})`;
    await t.close();
  }
});
async function fact(label = "a", project = p, salience = 0.4) {
  const b = uuidv7(),
    v = uuidv7(),
    o = uuidv7();
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,evidence_id,assertion_intent,source_type,authority,entities) values(${o},${project},'fact',${b},'db',${JSON.stringify("needle " + label)}::jsonb,${project === p ? message : foreignMessage},'ASSERT','USER_EXPLICIT',60,'["needle"]'::jsonb)`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,status,confidence,salience,importance) values(${b},${project},${b},'db','active',0.8,${salience},0.2)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,source_observation_id) values(${v},${b},${JSON.stringify("needle " + label)}::jsonb,'2020-01-01','2026-01-01',${o})`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${v},${"[" + [1, ...Array(1023).fill(0)].join(",") + "]"}::vector,'embed')`;
  return { b, v, o };
}
const trace = async (id: string) =>
  (await t.sql`select * from retrieval_traces where id=${id}`)[0]!;
const usage = () => t.sql`select * from model_usage where project_id=${p} and slot='reranker'`;
it.each([
  fusion,
  { mode: "weighted", weights: { vector: 0, keyword: 1, entity: 0, time: 0 }, threshold: 0.1 },
])(
  "metered real HTTP reranking changes TopK after %j fusion and keeps score-only trace",
  async (mode) => {
    const a = await fact("a"),
      b = await fact("b");
    const result = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts({ fusion: mode }));
    expect(result.candidates.map((c) => c.beliefVersionId)).toEqual([b.v]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text_2).toHaveLength(2);
    expect(admit).toHaveBeenCalledTimes(1);
    const row = await trace(result.traceId);
    expect(row.flags_snapshot).toEqual(snapshot());
    expect(row.candidates[0]).toMatchObject({
      beliefVersionId: b.v,
      selected: true,
      reranker: { model: qwen, status: "applied", rank: 1, score: 2 / 3 },
    });
    expect(row.candidates[1]).toMatchObject({
      beliefVersionId: a.v,
      selected: false,
      reranker: { rank: 2 },
    });
    expect(row.candidates[0].rankFusion.mode).toBe(mode.mode);
    expect(result.candidates[0]).not.toHaveProperty("reranker");
    for (const s of ["needle", "offline-rerank-private", endpoint])
      expect(JSON.stringify(row.candidates)).not.toContain(s);
    expect(await usage()).toHaveLength(1);
    expect((await usage())[0]).toMatchObject({
      conversation_id: conv,
      status: "success",
      prompt_tokens: "9",
      completion_tokens: null,
      total_tokens: "13",
    });
  },
);
it("disabled reranker preserves original DTO/trace candidates with zero extra quota/network/usage", async () => {
  const a = await fact("a");
  await fact("b");
  const options = opts({ flagsSnapshot: snapshot({ reranker: false }) });
  const result = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options);
  const { reranker: _unused, ...baseline } = options;
  const old = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", baseline);
  expect(result.candidates).toEqual(old.candidates);
  expect(result.candidates[0]?.beliefVersionId).toBe(a.v);
  expect((await trace(result.traceId)).candidates).toEqual((await trace(old.traceId)).candidates);
  expect(seen).toHaveLength(0);
  expect(admit).not.toHaveBeenCalled();
  expect(await usage()).toHaveLength(0);
});
it.each(["empty", "threshold"])("%s refusal never calls or reserves reranking", async (kind) => {
  if (kind === "threshold") await fact();
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    opts({ fusion: { ...fusion, threshold: 1 } }),
  );
  expect(r.abstained).toBe(true);
  expect(r.candidates).toEqual([]);
  expect(seen).toHaveLength(0);
  expect(admit).not.toHaveBeenCalled();
  expect(await usage()).toHaveLength(0);
  if (kind === "threshold")
    expect((await trace(r.traceId)).candidates[0].reranker).toEqual({
      model: qwen,
      status: "skipped",
      reason: "below_threshold",
    });
});
it.each(["error", "invalid", "timeout"])(
  "%s reranking falls back to fusion with a safe failure trace and one usage attempt",
  async (kind) => {
    const a = await fact("a");
    await fact("b");
    handler = (_w, res) => {
      if (kind === "error") {
        res.writeHead(503);
        res.end("private error");
      } else if (kind === "invalid") json(res, { private: "error" });
    };
    const r = await retrieve(
      t.db,
      TEST_MASTER_KEY,
      p,
      "needle",
      opts({ reranker: { endpoint, timeoutMs: 50 } }),
    );
    expect(r.candidates[0]?.beliefVersionId).toBe(a.v);
    expect(seen).toHaveLength(1);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(await usage()).toHaveLength(1);
    expect((await usage())[0]?.status).toBe("error");
    expect((await trace(r.traceId)).candidates[0].reranker).toEqual({
      model: qwen,
      status: "failed",
      code:
        kind === "error"
          ? "RERANK_FAILED"
          : kind === "invalid"
            ? "RERANK_INVALID_RESPONSE"
            : "RERANK_TIMEOUT",
    });
  },
);
it("oversize candidate text is never silently truncated or sent; fused fallback records the input rejection", async () => {
  const a = await fact("x".repeat(16384));
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts());
  expect(r.candidates[0]?.beliefVersionId).toBe(a.v);
  expect(seen).toHaveLength(0);
  expect(admit).not.toHaveBeenCalled();
  expect(await usage()).toHaveLength(0);
  expect((await trace(r.traceId)).candidates[0].reranker).toMatchObject({
    status: "failed",
    code: "INVALID_RERANK_INPUT",
  });
});
it.each(["exhausted", "unavailable"] as const)(
  "quota %s rejects instead of silently falling back",
  async (reason) => {
    await fact();
    const error = new ModelQuotaError(reason, 60);
    admit.mockRejectedValue(error);
    await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts())).rejects.toBe(error);
    expect(seen).toHaveLength(0);
    expect(await usage()).toHaveLength(0);
    expect(await t.sql`select id from retrieval_traces where project_id=${p}`).toHaveLength(0);
  },
);
it("abort during actual reranking rejects and never writes a successful retrieval trace", async () => {
  await fact();
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  handler = () => entered();
  const controller = new AbortController();
  const pending = retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts({ signal: controller.signal }));
  const checked = expect(pending).rejects.toThrow("RERANK_ABORTED");
  await Promise.race([ready, checked]);
  controller.abort("private reason");
  await checked;
  expect((await usage())[0]?.status).toBe("aborted");
  expect(await t.sql`select id from retrieval_traces where project_id=${p}`).toHaveLength(0);
});
it("final budget/reinforcement applies only after reranked TopK, using original salience priorities", async () => {
  const a = await fact("a", p, 0.9),
    b = await fact("b", p, 0.8),
    c = await fact("c", p, 0.1);
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    opts({
      topK: 2,
      flagsSnapshot: snapshot({ read_time_reinforcement: true }),
      memoryBudget: {
        maxTokens: 1,
        countTokens: (s: string) => (s === "（无相关记忆）" ? 0 : s.split("\n").length),
      },
    }),
  );
  expect(r.candidates.map((x) => x.beliefVersionId)).toEqual([b.v]);
  const row = await trace(r.traceId);
  expect(
    row.candidates.find((x: { beliefVersionId: string }) => x.beliefVersionId === c.v),
  ).toMatchObject({ selected: false, reason: "token_budget", reranker: { rank: 1 } });
  const beliefs = await t.sql`select id,salience from beliefs where project_id=${p} order by id`;
  expect(beliefs).toEqual([
    { id: a.b, salience: "0.900" },
    { id: b.b, salience: "0.850" },
    { id: c.b, salience: "0.100" },
  ]);
});
it("foreign/deleted/closed/non-current/out-of-time versions cannot be sent to the reranker", async () => {
  const good = await fact("good"),
    foreign = await fact("foreign", other),
    deleted = await fact("deleted"),
    closed = await fact("closed"),
    old = await fact("old"),
    future = await fact("future");
  await t.sql`update beliefs set status='deleted' where id=${deleted.b}`;
  await t.sql`update belief_versions set recorded_to='2026-02-01' where id=${closed.v}`;
  await t.sql`update beliefs set current_version_id=null where id=${old.b}`;
  await t.sql`update belief_versions set valid_from='2030-01-01' where id=${future.v}`;
  const before =
    await t.sql`select row_to_json(b)::text as text from beliefs b where project_id in (${p},${other}) order by id`;
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    opts({ flagsSnapshot: snapshot({ retrieval_time: true }), validAt: "2026-01-01T00:00:00Z" }),
  );
  expect(r.candidates.map((x) => x.beliefVersionId)).toEqual([good.v]);
  expect(seen[0]!.text_2).toHaveLength(1);
  for (const text of [foreign.b, deleted.b, closed.b, old.b, future.b])
    expect(JSON.stringify(seen)).not.toContain(text);
  expect(
    await t.sql`select row_to_json(b)::text as text from beliefs b where project_id in (${p},${other}) order by id`,
  ).toEqual(before);
});
it.each(Array.from({ length: 16 }, (_, n) => n))(
  "source/time mask %i remains independently controllable with reranking",
  async (mask) => {
    await fact();
    const flags = {
      retrieval_vector: !!(mask & 1),
      retrieval_keyword: !!(mask & 2),
      retrieval_entity: !!(mask & 4),
      retrieval_time: !!(mask & 8),
    };
    const r = await retrieve(
      t.db,
      TEST_MASTER_KEY,
      p,
      "needle",
      opts({ flagsSnapshot: snapshot(flags), validAt: "2026-01-01T00:00:00Z" }),
    );
    const count = mask & 7 ? 1 : 0;
    expect(r.candidates).toHaveLength(count);
    expect(seen).toHaveLength(count);
    expect(await usage()).toHaveLength(count);
    expect(model.embedding).toHaveBeenCalledTimes(flags.retrieval_vector ? 1 : 0);
    // A vector invocation has its own quota reservation, independently of the Score API batch.
    expect(admit).toHaveBeenCalledTimes((flags.retrieval_vector ? 1 : 0) + count);
    expect((await trace(r.traceId)).flags_snapshot).toEqual(snapshot(flags));
  },
);
it.each([
  { fusion: undefined },
  { fusion: { ...fusion, maxCandidates: 201 } },
  { admitModelCall: undefined },
  { flagsSnapshot: undefined },
])("malformed explicit binding fails before database/model access: %j", async (override) => {
  const db = new Proxy(t.db, {
    get() {
      throw Error("DB must not be read");
    },
  });
  await expect(retrieve(db, TEST_MASTER_KEY, p, "needle", opts(override as never))).rejects.toThrow(
    "INVALID_RUNTIME_RERANK_OPTIONS",
  );
  expect(seen).toHaveLength(0);
  expect(admit).not.toHaveBeenCalled();
});
it("enabled flag without a binding stays unsupported; public recall cannot inject credentials or flags", async () => {
  await fact();
  const { reranker: _unused, ...missing } = opts();
  await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", missing)).rejects.toThrow(
    "unsupported feature flag enabled",
  );
  expect(seen).toHaveLength(0);
  const app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: "offline-runtime-reranker-token-0000000000",
    logStream: { write: () => {} },
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: `/projects/${p}/recall`,
      headers: { authorization: "Bearer offline-runtime-reranker-token-0000000000" },
      payload: { query: "needle", reranker: { endpoint }, flagsSnapshot: snapshot() },
    });
    expect(res.statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  } finally {
    await app.close();
  }
});

it("an already cancelled binding rejects before any database access", async () => {
  const db = new Proxy(t.db, {
    get() {
      throw Error("DB must not be read");
    },
  });
  await expect(
    retrieve(db, TEST_MASTER_KEY, p, "needle", opts({ signal: AbortSignal.abort("private") })),
  ).rejects.toThrow("RERANK_ABORTED");
  expect(seen).toHaveLength(0);
  expect(admit).not.toHaveBeenCalled();
});
it("cancellation during final budgeting cannot create a success trace or reinforcement", async () => {
  const f = await fact();
  const controller = new AbortController();
  const pending = retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    opts({
      signal: controller.signal,
      flagsSnapshot: snapshot({ read_time_reinforcement: true }),
      memoryBudget: {
        maxTokens: 1,
        countTokens: () => {
          controller.abort("private");
          return 1;
        },
      },
    }),
  );
  await expect(pending).rejects.toThrow("RERANK_ABORTED");
  expect((await usage())[0]?.status).toBe("success");
  expect(await t.sql`select id from retrieval_traces where project_id=${p}`).toHaveLength(0);
  expect((await t.sql`select salience from beliefs where id=${f.b}`)[0]?.salience).toBe("0.400");
});
it("config/snapshot/scope/admission changes during query embedding cannot replace the captured reranker", async () => {
  await fact("a");
  const b = await fact("b");
  const mutable = {
    schema_version: 1 as const,
    revision: 9,
    flags: { ...DEFAULT_FEATURE_FLAGS, reranker: true },
  };
  const config = { endpoint, apiKey: "offline-rerank-private" },
    context = { projectId: p, conversationId: conv, purpose: "chat" as const };
  const options: RetrieveOptions = opts({
    flagsSnapshot: mutable,
    reranker: config,
    usageContext: context,
  });
  const wrong = vi.fn(async () => {
    throw Error("mutated admission");
  });
  model.embedding.mockImplementationOnce(async ({ values }) => {
    config.endpoint = "http://127.0.0.1:1/score";
    config.apiKey = "changed";
    mutable.flags.reranker = false;
    context.projectId = other;
    context.conversationId = foreignConv;
    options.admitModelCall = wrong;
    return { embeddings: values.map(() => [1, ...Array(1023).fill(0)]), usage: { tokens: 3 } };
  });
  const result = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options);
  expect(result.candidates[0]?.beliefVersionId).toBe(b.v);
  expect(wrong).not.toHaveBeenCalled();
  expect(seen).toHaveLength(1);
  expect(admit).toHaveBeenCalledTimes(2);
  expect((await trace(result.traceId)).flags_snapshot.flags.reranker).toBe(true);
  expect((await usage())[0]?.conversation_id).toBe(conv);
});
it("unknown admission failure is not an ordinary ranking fallback", async () => {
  await fact();
  admit.mockRejectedValue(Error("private database secret"));
  await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts())).rejects.toThrow(
    /^RERANK_ADMISSION_FAILED$/,
  );
  expect(seen).toHaveLength(0);
  expect(await usage()).toHaveLength(0);
  expect(await t.sql`select id from retrieval_traces where project_id=${p}`).toHaveLength(0);
});
it("zero scores only affect order; they do not invent a second uncalibrated refusal threshold", async () => {
  const f = await fact();
  handler = (wire, res) =>
    json(res, {
      object: "list",
      model: qwen,
      data: wire.text_2.map((_, i) => ({ object: "score", index: i, score: 0 })),
    });
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts());
  expect(r.abstained).toBe(false);
  expect(r.candidates[0]?.beliefVersionId).toBe(f.v);
  expect((await trace(r.traceId)).candidates[0].reranker).toMatchObject({
    status: "applied",
    score: 0,
  });
});

it("aggregate byte overflow also falls back without splitting the batch or reserving quota", async () => {
  const first = await fact("x".repeat(13100));
  for (let n = 0; n < 4; n++) await fact("y".repeat(13100));
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts());
  expect(r.candidates[0]?.beliefVersionId).toBe(first.v);
  expect(seen).toHaveLength(0);
  expect(admit).not.toHaveBeenCalled();
  expect(await usage()).toHaveLength(0);
  expect((await trace(r.traceId)).candidates[0].reranker).toMatchObject({
    status: "failed",
    code: "INVALID_RERANK_INPUT",
  });
});
it("a foreign physical conversation cannot turn into an ordinary ranking fallback", async () => {
  await fact();
  await expect(
    retrieve(
      t.db,
      TEST_MASTER_KEY,
      p,
      "needle",
      opts({ usageContext: { projectId: p, conversationId: foreignConv, purpose: "chat" } }),
    ),
  ).rejects.toThrow(/^INVALID_RERANK_SCOPE$/);
  expect(seen).toHaveLength(0);
  expect(admit).not.toHaveBeenCalled();
  expect(await usage()).toHaveLength(0);
  expect(await t.sql`select id from retrieval_traces where project_id=${p}`).toHaveLength(0);
});
