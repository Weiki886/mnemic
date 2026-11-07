import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { uuidv7 } from "uuidv7";
import { Ajv } from "ajv";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DEFAULT_FEATURE_FLAGS, createFeatureFlagSnapshot } from "@mnemic/shared/flags";
import { RecallResultSchema } from "@mnemic/shared/memory";
import { retrieve } from "../src/retrieval/search.js";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { readFeatureFlags } from "../src/flags/repository.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { durableModels } from "./fixtures/durable-models.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb, savedFlags: Awaited<ReturnType<typeof readFeatureFlags>>;
const p = uuidv7(),
  other = uuidv7(),
  providerName = `time-${uuidv7()}`,
  model = durableModels();
const point = "2026-06-01T00:00:00.123456Z";
const snapshot = (extra = {}) =>
  createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, retrieval_time: true, ...extra },
  });
const opts = (extra = {}) => ({
  providerName,
  factory: model.factory,
  flagsSnapshot: snapshot(),
  validAt: point,
  ...extra,
});
beforeAll(async () => {
  t = await setupTestDb();
  savedFlags = await readFeatureFlags(t.db);
  await t.sql`insert into projects(id,name) values(${p},'runtime time'),(${other},'other runtime time')`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: providerName,
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { embedding: "embed" },
  });
}, 180000);
afterEach(async () => {
  vi.useRealTimers();
  model.embedding.mockClear();
  await t.sql`update feature_flags set flags=${JSON.stringify(savedFlags.flags)}::jsonb,revision=${savedFlags.revision} where scope='server'`;
  await t.sql`delete from retrieval_traces where project_id in (${p},${other})`;
  await t.sql`delete from model_usage where project_id in (${p},${other})`;
  await t.sql`update beliefs set current_version_id=null where project_id in (${p},${other})`;
  await t.sql`delete from memory_embeddings where belief_version_id in(select v.id from belief_versions v join beliefs b on b.id=v.belief_id where b.project_id in (${p},${other}))`;
  await t.sql`delete from belief_versions where belief_id in(select id from beliefs where project_id in (${p},${other}))`;
  await t.sql`delete from beliefs where project_id in (${p},${other})`;
});
afterAll(async () => {
  if (t) {
    await t.sql`delete from provider_configs where name=${providerName}`;
    await t.sql`delete from projects where id in (${p},${other})`;
    await t.close();
  }
});
async function fact(from: string, to: string | null = null, project = p, indexed = false) {
  const b = uuidv7(),
    v = uuidv7();
  await t.sql`insert into beliefs(id,project_id,subject,attribute,salience,confidence) values(${b},${project},${b},'db',0.5,0.8)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,valid_to,recorded_from) values(${v},${b},'"needle"',${from}::timestamptz,${to}::timestamptz,'2026-01-01')`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  if (indexed)
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${v},${"[" + [1, ...Array(1023).fill(0)].join(",") + "]"}::vector,'embed')`;
  return { b, v };
}
async function trace(id: string) {
  return (await t.sql`select * from retrieval_traces where id=${id}`)[0]!;
}
it("stored-supported time flag selects current [from,to) using full microseconds and records the actual point", async () => {
  const open = await fact(point),
    before = await fact("2020-01-01", point),
    future = await fact("2026-06-01T00:00:00.123457Z"),
    endingLater = await fact("2020-01-01", "2026-06-01T00:00:00.123457Z");
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts());
  expect(new Set(r.candidates.map((c) => c.beliefVersionId))).toEqual(
    new Set([open.v, endingLater.v]),
  );
  expect(r.candidates.some((c) => [before.v, future.v].includes(c.beliefVersionId))).toBe(false);
  const row = await trace(r.traceId);
  expect(row.query_valid_at).toBe(point);
  expect(row.flags_snapshot).toEqual(snapshot());
  expect(model.embedding).not.toHaveBeenCalled();
});
it("flag off retains the legacy candidate set and records no active filter point", async () => {
  const a = await fact("2020-01-01", "2021-01-01"),
    b = await fact("2099-01-01");
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    opts({ flagsSnapshot: snapshot({ retrieval_time: false }) }),
  );
  expect(new Set(r.candidates.map((c) => c.beliefVersionId))).toEqual(new Set([a.v, b.v]));
  const row = await trace(r.traceId);
  expect(row.query_valid_at).toBeNull();
  expect(row.candidates.every((c: object) => !("rankFusion" in c))).toBe(true);
});
it("time is a filter, so zero matches and all source routes disabled still produce an empty trace with the point", async () => {
  await fact("2099-01-01");
  const empty = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts());
  expect(empty.abstained).toBe(true);
  expect((await trace(empty.traceId)).query_valid_at).toBe(point);
  const off = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    opts({ flagsSnapshot: snapshot({ retrieval_keyword: false }) }),
  );
  expect(off.abstained).toBe(true);
  expect((await trace(off.traceId)).candidates).toEqual([]);
  expect((await trace(off.traceId)).query_valid_at).toBe(point);
  expect(model.embedding).not.toHaveBeenCalled();
});
it("filters vector-only candidates and does not permit expired/future versions through another source", async () => {
  const good = await fact("2020-01-01", null, p, true);
  await fact("2020-01-01", point, p, true);
  await fact("2099-01-01", null, p, true);
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "unmatched",
    opts({ flagsSnapshot: snapshot({ retrieval_vector: true, retrieval_keyword: false }) }),
  );
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
  expect(model.embedding).toHaveBeenCalledOnce();
});
it("time filtering keeps project/current/active ownership and never falls back to an eligible historical version", async () => {
  const current = await fact("2099-01-01"),
    good = await fact("2020-01-01"),
    deleted = await fact("2020-01-01"),
    foreign = await fact("2020-01-01", null, other);
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,valid_to,recorded_from,recorded_to) values(${uuidv7()},${current.b},'"needle"','2020-01-01','2027-01-01','2020-01-01','2021-01-01')`;
  await t.sql`update beliefs set status='deleted' where id=${deleted.b}`;
  const corrupt = await fact("2020-01-01");
  await t.sql`update beliefs set current_version_id=${foreign.v} where id=${corrupt.b}`;
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", opts());
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
});
it("captures default server time before the SDK wait, not when the query or trace finally runs", async () => {
  await fact("2026-01-02T00:00:00Z", null, p, true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const normal = model.embedding.getMockImplementation()!;
  model.embedding.mockImplementationOnce(async (args) => {
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
    return normal(args);
  });
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "unmatched", {
    providerName,
    factory: model.factory,
    flagsSnapshot: snapshot({ retrieval_vector: true, retrieval_keyword: false }),
  });
  expect(r.abstained).toBe(true);
  expect((await trace(r.traceId)).query_valid_at).toBe("2026-01-01T00:00:00.000Z");
});
it("pins an explicit point despite caller mutation during embedding", async () => {
  const good = await fact("2020-01-01", point, p, true);
  const input = opts({
      flagsSnapshot: snapshot({ retrieval_vector: true, retrieval_keyword: false }),
      validAt: "2026-06-01T00:00:00.123455Z",
    }),
    normal = model.embedding.getMockImplementation()!;
  model.embedding.mockImplementationOnce(async (args) => {
    input.validAt = "2099-01-01T00:00:00Z";
    return normal(args);
  });
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "unmatched", input);
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
  expect((await trace(r.traceId)).query_valid_at).toBe("2026-06-01T00:00:00.123455Z");
});
it("combines current time filtering with explicit RRF and budget without modifying belief/version rows", async () => {
  const good = await fact("2020-01-01");
  await fact("2099-01-01");
  const before =
    await t.sql`select row_to_json(b) as b,row_to_json(v) as v from beliefs b join belief_versions v on v.belief_id=b.id where b.project_id=${p} order by b.id,v.id`;
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    opts({
      fusion: { mode: "rrf", threshold: 0.01 },
      memoryBudget: {
        maxTokens: 1,
        countTokens: (s: string) => (s === "（无相关记忆）" ? 0 : s.split("\n").length),
      },
    }),
  );
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
  expect((await trace(r.traceId)).candidates[0].rankFusion.mode).toBe("rrf");
  expect(
    await t.sql`select row_to_json(b) as b,row_to_json(v) as v from beliefs b join belief_versions v on v.belief_id=b.id where b.project_id=${p} order by b.id,v.id`,
  ).toEqual(before);
});
it.each([
  null,
  0,
  "sk-private",
  "2026-02-30T00:00:00Z",
  "2026-01-01T00:00:00.1234567Z",
  "2026-01-01T00:00:00+00:00",
])(
  "invalid trusted time %# is rejected before DB/model reads even while the flag is off",
  async (validAt) => {
    let reads = 0;
    const db = new Proxy({} as PostgresJsDatabase, {
      get() {
        reads++;
        throw Error("DB tripwire");
      },
    });
    await expect(retrieve(db, TEST_MASTER_KEY, p, "needle", { validAt })).rejects.toThrow(
      /^INVALID_RECALL_TIME$/,
    );
    expect(reads).toBe(0);
  },
);
it("new nullable trace column upgrades existing rows without fabricating time and supports SQL replay", async () => {
  const ddl = readFileSync(
    new URL("../drizzle/0017_retrieval_query_time.sql", import.meta.url),
    "utf8",
  );
  expect(ddl.trim()).toBe(
    'ALTER TABLE "retrieval_traces" ADD COLUMN IF NOT EXISTS "query_valid_at" text;',
  );
  await t.sql.begin(async (tx) => {
    await tx`create temporary table retrieval_traces(id uuid primary key,payload text) on commit drop`;
    const id = uuidv7();
    await tx`insert into retrieval_traces(id,payload) values(${id},'legacy')`;
    await tx.unsafe(ddl);
    await tx.unsafe(ddl);
    expect(await tx`select payload,query_valid_at from retrieval_traces where id=${id}`).toEqual([
      { payload: "legacy", query_valid_at: null },
    ]);
  });
});
it("real authenticated TCP flags update enables recall filtering; old public DTO and unknown-body protection stay intact", async () => {
  const future = await fact("2099-01-01"),
    token = "offline-time-auth-token-000000000000";
  const app = buildApp({
    authToken: token,
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    providerFactory: model.factory,
    logStream: { write: () => {} },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 }),
      headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const before = await readFeatureFlags(t.db);
    const put = await fetch(address + "/v1/config/flags", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expected_revision: before.revision,
        flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, retrieval_time: true },
      }),
    });
    expect(put.status).toBe(200);
    const response = await fetch(address + `/projects/${p}/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "needle" }),
    });
    expect(response.status).toBe(200);
    const rawBody = await response.json();
    const body = RecallResultSchema.parse(rawBody);
    expect(RecallResultSchema.safeParse(body).success).toBe(true);
    const artifact = JSON.parse(
      readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv({ strict: false, formats: { uuid: true, "date-time": true } });
    ajv.addSchema({ components: artifact.components }, "time-contract");
    const responseSchema =
      artifact.paths["/projects/{projectId}/recall"].post.responses["200"].content[
        "application/json"
      ].schema;
    const independent = ajv.compile(
      JSON.parse(
        JSON.stringify(responseSchema).replaceAll('"#/components/', '"time-contract#/components/'),
      ),
    );
    expect(independent(rawBody), JSON.stringify(independent.errors)).toBe(true);
    expect(body.abstained).toBe(true);
    expect(body.candidates).toEqual([]);
    const row = await trace(body.trace.id);
    expect(row.query_valid_at).toMatch(/^\d{4}-/);
    expect(row.flags_snapshot.flags.retrieval_time).toBe(true);
    expect(body.trace).not.toHaveProperty("query_valid_at");
    expect(body.trace).not.toHaveProperty("validAt");
    expect(model.embedding).not.toHaveBeenCalled();
    const invalid = await fetch(address + `/projects/${p}/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "needle", validAt: point }),
    });
    expect(invalid.status).toBe(400);
    expect(
      (await t.sql`select current_version_id from beliefs where id=${future.b}`)[0]!
        .current_version_id,
    ).toBe(future.v);
  } finally {
    await app.close();
  }
});
it("enabling only the time filter preserves accepted long legacy chat queries without forcing bounded fusion", async () => {
  const good = await fact("2020-01-01");
  const query = Array(300).fill("needle").join(" ");
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, query, opts());
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
  expect((await trace(r.traceId)).candidates[0]).not.toHaveProperty("rankFusion");
});
