import { APICallError } from "ai";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { createModelQuota } from "../src/quota/repository.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { readFeatureFlags } from "../src/flags/repository.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { durableModels } from "./fixtures/durable-models.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb,
  app: ReturnType<typeof buildApp> | undefined,
  projectId: string,
  logs = "",
  m: ReturnType<typeof durableModels>;
let saved: { day: string; calls: string }[],
  savedFlags: Awaited<ReturnType<typeof readFeatureFlags>>;
const authToken = "quota-runtime-offline-token-0000000",
  headers = { authorization: `Bearer ${authToken}` };
beforeAll(async () => {
  t = await setupTestDb();
  saved = await t.sql`select day::text,calls::text from model_daily_quota`;
  savedFlags = await readFeatureFlags(t.db);
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "quota-runtime",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "sk-private-offline",
    models: { chat: "chat", extraction: "extract", embedding: "embed" },
  });
}, 180000);
beforeEach(async () => {
  logs = "";
  m = durableModels();
  projectId = uuidv7();
  await t.sql`delete from model_daily_quota`;
  await t.sql`update feature_flags set flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb where scope='server'`;
  await t.sql`insert into projects(id,name) values(${projectId},'quota-test')`;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await waitForChatJobs();
});
afterAll(async () => {
  if (t) {
    await t.sql`delete from model_daily_quota`;
    for (const r of saved ?? [])
      await t.sql`insert into model_daily_quota values(${r.day}::date,${r.calls}::bigint)`;
    await t.sql`update feature_flags set flags=${JSON.stringify(savedFlags.flags)}::jsonb,revision=${savedFlags.revision} where scope='server'`;
    await t.close();
  }
});
function build(extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken,
    modelDailyCallLimit: 1,
    providerFactory: m.factory,
    logStream: {
      write: (s) => {
        logs += s;
      },
    },
    chatDeps: { retrieveFn: async () => ({ candidates: [], abstained: true, traceId: uuidv7() }) },
    ...extra,
  });
  return app;
}
async function conversation() {
  const id = uuidv7();
  await t.sql`insert into conversations(id,project_id) values(${id},${projectId})`;
  return id;
}
const used = () => t.sql`select calls::int from model_daily_quota`;
it("JSON chat rejects exhaustion as 429 without phantom usage, answers, or model invocations", async () => {
  const a = build();
  await createModelQuota(t.db, 1)();
  const id = await conversation();
  const r = await a.inject({
    method: "POST",
    url: `/projects/${projectId}/conversations/${id}/messages`,
    headers,
    payload: { text: "quota secret user text" },
  });
  expect(r.statusCode).toBe(429);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  expect(r.json()).toMatchObject({ code: "MODEL_QUOTA_EXCEEDED", status: 429 });
  expect(m.generate).not.toHaveBeenCalled();
  expect(m.embedding).not.toHaveBeenCalled();
  expect(await t.sql`select * from model_usage where project_id=${projectId}`).toEqual([]);
  expect(
    await t.sql`select * from messages where conversation_id=${id} and speaker='assistant'`,
  ).toEqual([]);
  expect(logs).toContain("model daily quota exhausted");
  expect(logs).not.toMatch(/sk-private|quota secret user text/);
});
it("accepted chat consumes one shared budget and legacy extraction degrades without another model call", async () => {
  const a = build(),
    id = await conversation();
  const r = await a.inject({
    method: "POST",
    url: `/projects/${projectId}/conversations/${id}/messages`,
    headers,
    payload: { text: "database PostgreSQL" },
  });
  expect(r.statusCode).toBe(200);
  await waitForChatJobs();
  expect(m.generate).toHaveBeenCalledTimes(1);
  expect(m.embedding).not.toHaveBeenCalled();
  expect(await used()).toEqual([{ calls: 1 }]);
  expect(await t.sql`select * from observations where project_id=${projectId}`).toEqual([]);
  expect(await t.sql`select * from model_usage where project_id=${projectId}`).toHaveLength(1);
});
it("SSE exhaustion produces failed terminal frame and never a fabricated successful answer", async () => {
  const a = build();
  await createModelQuota(t.db, 1)();
  const id = await conversation();
  const r = await a.inject({
    method: "POST",
    url: `/projects/${projectId}/conversations/${id}/messages/stream`,
    headers,
    payload: { text: "x" },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('"code":"GENERATION_FAILED"');
  expect(r.body).not.toContain("event: finish");
  expect(
    await t.sql`select generation_status,raw_text from messages where conversation_id=${id} and speaker='assistant'`,
  ).toEqual([{ generation_status: "failed", raw_text: "" }]);
  expect(await t.sql`select * from model_usage where project_id=${projectId}`).toEqual([]);
});
it("read-only diagnosis spends nothing; explicit three-slot probe shares one quota", async () => {
  const a = build();
  expect((await a.inject({ url: "/v1/doctor", headers })).statusCode).toBe(200);
  expect(await used()).toEqual([]);
  const r = await a.inject({ method: "POST", url: "/v1/doctor/probe", headers, payload: {} });
  expect(r.statusCode).toBe(200);
  expect(r.json().ok).toBe(false);
  expect(await used()).toEqual([{ calls: 1 }]);
  expect(m.generate.mock.calls.length + m.embedding.mock.calls.length).toBe(1);
  expect(
    r
      .json()
      .checks.filter(
        (c: { name: string; status: string }) =>
          ["chat", "extraction", "embedding"].includes(c.name) && c.status === "error",
      ),
  ).toHaveLength(2);
});
it("recall at quota degrades to keyword-only without invoking the embedding model", async () => {
  const a = build();
  await createModelQuota(t.db, 1)();
  const r = await a.inject({
    method: "POST",
    url: `/projects/${projectId}/recall`,
    headers,
    payload: { query: "postgres" },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().abstained).toBe(true);
  expect(m.embedding).not.toHaveBeenCalled();
  expect(await used()).toEqual([{ calls: 1 }]);
  expect(await t.sql`select * from retrieval_traces where project_id=${projectId}`).toHaveLength(1);
});
it("managed durable extraction remains retryable without marking Evidence extracted or writing facts", async () => {
  await createModelQuota(t.db, 1)();
  const id = await conversation(),
    evidence = uuidv7();
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${evidence},${id},'user','database PostgreSQL',now())`;
  const a = build({ extractionQueue: { projectId, pollMs: 10 } });
  await a.ready();
  await vi.waitFor(
    async () => {
      const rows = await t.sql`select status from memory_tasks where project_id=${projectId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("failed");
    },
    { timeout: 5000 },
  );
  expect(m.generate).not.toHaveBeenCalled();
  expect(m.embedding).not.toHaveBeenCalled();
  expect(await t.sql`select * from observations where project_id=${projectId}`).toEqual([]);
  expect(
    (await t.sql`select extracted_at from messages where id=${evidence}`)[0]!.extracted_at,
  ).toBeNull();
});
it("actual TCP authenticated requests share the persisted cap across app restarts", async () => {
  let a = build();
  let url = await a.listen({ host: "127.0.0.1", port: 0 });
  const probe = () =>
    fetch(`${url}/v1/doctor/probe`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
  expect((await probe()).status).toBe(200);
  await a.close();
  app = undefined;
  m.generate.mockClear();
  m.embedding.mockClear();
  a = build();
  url = await a.listen({ host: "127.0.0.1", port: 0 });
  const report = await (await probe()).json();
  expect(report).toMatchObject({ ok: false });
  expect(m.generate).not.toHaveBeenCalled();
  expect(m.embedding).not.toHaveBeenCalled();
  expect(await used()).toEqual([{ calls: 1 }]);
});
it("invalid quota options fail before touching the database", () => {
  const db = new Proxy(
    {},
    {
      get() {
        throw Error("unexpected DB access");
      },
    },
  ) as TestDb["db"];
  for (const n of [0, -1, NaN, 1.5])
    expect(() => buildApp({ auth: false, db, modelDailyCallLimit: n })).toThrow();
});
it("quota storage failure returns safe 503 without invoking a provider", async () => {
  const a = build(),
    id = await conversation();
  await t.sql`alter table model_daily_quota add constraint quota_test_failure check(calls=0) not valid`;
  try {
    const r = await a.inject({
      method: "POST",
      url: `/projects/${projectId}/conversations/${id}/messages`,
      headers,
      payload: { text: "private" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({
      code: "MODEL_QUOTA_UNAVAILABLE",
      title: "Service Unavailable",
    });
    expect(r.headers["retry-after"]).toBe("60");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(m.generate).not.toHaveBeenCalled();
    expect(await used()).toEqual([]);
    expect(logs).toContain("model daily quota unavailable");
    expect(logs).not.toContain("quota_test_failure");
  } finally {
    await t.sql`alter table model_daily_quota drop constraint quota_test_failure`;
  }
});

it.each([1, 2])(
  "SDK retries reserve separately; limit %s never allows a second unpaid admission",
  async (limit) => {
    const a = build({ modelDailyCallLimit: limit }),
      id = await conversation();
    m.generate.mockRejectedValueOnce(
      new APICallError({
        message: "private-provider-payload",
        url: "https://example.invalid",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      }),
    );
    const r = await a.inject({
      method: "POST",
      url: `/projects/${projectId}/conversations/${id}/messages`,
      headers,
      payload: { text: "x" },
    });
    expect(r.statusCode).toBe(limit === 1 ? 429 : 200);
    await waitForChatJobs();
    expect(m.generate).toHaveBeenCalledTimes(limit);
    expect(await used()).toEqual([{ calls: limit }]);
    const rows =
      await t.sql`select status from model_usage where project_id=${projectId} order by started_at`;
    expect(rows.map((r) => r.status)).toEqual(limit === 1 ? ["error"] : ["error", "success"]);
    expect(r.body).not.toContain("private-provider-payload");
    expect(logs).not.toContain("private-provider-payload");
  },
);
