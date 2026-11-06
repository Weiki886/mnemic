import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { retrieve } from "../src/retrieval/search.js";
import { readFusedCandidates } from "../src/retrieval/runtime-fusion.js";
import { DEFAULT_FEATURE_FLAGS, createFeatureFlagSnapshot } from "@mnemic/shared/flags";
import { createProvider } from "../src/providers/repository.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { durableModels } from "./fixtures/durable-models.js";
let t: TestDb;
const p = uuidv7(),
  other = uuidv7(),
  providerName = `fusion-${uuidv7()}`;
const model = durableModels();
const weights = { vector: 0.7, keyword: 0.3, entity: 0, time: 0 };
const weighted = { mode: "weighted" as const, weights, threshold: 0.1 };
const rrf = { mode: "rrf" as const, threshold: 0.01 };
const snapshot = (flags = {}) =>
  createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS, ...flags },
  });
const options = (fusion: unknown) => ({
  providerName,
  factory: model.factory,
  flagsSnapshot: snapshot(),
  topK: 1,
  fusion,
});
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${p},'runtime fusion'),(${other},'other runtime fusion')`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: providerName,
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { embedding: "embed" },
  });
}, 180000);
afterEach(async () => {
  model.embedding.mockClear();
  await t.sql`delete from retrieval_traces where project_id in (${p},${other})`;
  await t.sql`delete from model_usage where project_id in (${p},${other})`;
  await t.sql`update beliefs set current_version_id=null where project_id in (${p},${other})`;
  await t.sql`delete from memory_embeddings where belief_version_id in (select v.id from belief_versions v join beliefs b on b.id=v.belief_id where b.project_id in (${p},${other}))`;
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
async function fact(value: unknown, axis: number | null = null, project = p, modelId = "embed") {
  const b = uuidv7(),
    v = uuidv7();
  await t.sql`insert into beliefs(id,project_id,subject,attribute,confidence,salience,importance) values(${b},${project},${b},'db',0.8,0.4,0.2)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${v},${b},${JSON.stringify(value)}::jsonb,'2026-01-01','2026-01-01')`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  if (axis !== null)
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${v},${"[" + Array.from({ length: 1024 }, (_, i) => (i === axis ? 1 : 0)).join(",") + "]"}::vector,${modelId})`;
  return { b, v };
}
it("real retrieve can compare weighted and RRF rankings and persists only score/rank/algorithm metadata", async () => {
  const a = await fact("semantic-only", 0),
    b = await fact("needle", 1);
  const w = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options(weighted));
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options(rrf));
  expect(w.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([b.v]);
  expect(r.candidates[0]!.fusedScore).toBeCloseTo(1 / 61 + 1 / 62, 12);
  const [trace] = await t.sql`select * from retrieval_traces where id=${r.traceId}`;
  expect(trace!.flags_snapshot).toEqual(snapshot());
  const candidate = trace!.candidates.find(
    (c: { beliefVersionId: string }) => c.beliefVersionId === b.v,
  );
  expect(candidate.rankFusion).toMatchObject({
    mode: "rrf",
    k: 60,
    threshold: 0.01,
    perRouteLimit: 200,
    maxCandidates: 200,
    components: [
      { route: "keyword", rank: 1 },
      { route: "vector", rank: 2 },
    ],
  });
  expect(JSON.stringify(trace!.candidates)).not.toContain("needle");
  expect(candidate).not.toHaveProperty("value");
  expect(r.candidates[0]).not.toHaveProperty("rankFusion");
  expect(model.embedding).toHaveBeenCalledTimes(2);
});
it("RRF uses its explicit threshold, including refusal, instead of inheriting the A0 0.3 threshold", async () => {
  await fact("needle", 0);
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options(rrf));
  expect(r.abstained).toBe(false);
  const refused = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ ...rrf, threshold: 0.1 }),
  );
  expect(refused.abstained).toBe(true);
  expect(refused.candidates).toEqual([]);
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${refused.traceId}`;
  expect(trace!.candidates[0]).toMatchObject({
    selected: false,
    reason: "below_threshold",
    rankFusion: { threshold: 0.1 },
  });
});
it("omitting experimental options preserves the legacy candidate DTO and weighted behavior", async () => {
  await fact("semantic-only", 0);
  await fact("needle", 1);
  const legacy = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", {
    providerName,
    factory: model.factory,
    flagsSnapshot: snapshot(),
    topK: 1,
    threshold: 0.1,
  });
  const enhanced = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options(weighted));
  expect(enhanced.candidates).toEqual(legacy.candidates);
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${legacy.traceId}`;
  expect(trace!.candidates.every((c: object) => !("rankFusion" in c))).toBe(true);
});
it("enhanced retrieval uses only the selected embedding model and current active project-owned versions", async () => {
  const good = await fact("own", 0);
  await fact("foreign", 0, other);
  await fact("wrong-model", 0, p, "wrong-model");
  const deleted = await fact("deleted", 0),
    closed = await fact("recorded-closed", 0),
    corrupt = await fact("corrupt", null);
  const foreign = await fact("foreign pointer", 0, other);
  await t.sql`update beliefs set status='deleted' where id=${deleted.b}`;
  await t.sql`update belief_versions set recorded_to='2026-02-01' where id=${closed.v}`;
  await t.sql`update beliefs set current_version_id=${foreign.v} where id=${corrupt.b}`;
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "unmatched", {
    ...options(weighted),
    topK: 5,
  });
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
});
it("vector disabled invokes no model and weighted keyword fallback remains available", async () => {
  const f = await fact("needle");
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", {
    ...options(weighted),
    flagsSnapshot: snapshot({ retrieval_vector: false }),
  });
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([f.v]);
  expect(model.embedding).not.toHaveBeenCalled();
});
it("failed query embedding degrades to keyword without retrying the fused query as a legacy request", async () => {
  const f = await fact("needle");
  model.embedding.mockRejectedValueOnce(Error("offline"));
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options(rrf));
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([f.v]);
  expect(model.embedding).toHaveBeenCalledTimes(1);
  expect((await t.sql`select id from retrieval_traces where project_id=${p}`).length).toBe(1);
});
it("both routes off abstain with a real empty trace and no model calls", async () => {
  await fact("needle", 0);
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", {
    ...options(rrf),
    flagsSnapshot: snapshot({ retrieval_vector: false, retrieval_keyword: false }),
  });
  expect(r.candidates).toEqual([]);
  expect(r.abstained).toBe(true);
  expect(model.embedding).not.toHaveBeenCalled();
  expect(
    (await t.sql`select candidates from retrieval_traces where id=${r.traceId}`)[0]!.candidates,
  ).toEqual([]);
});
it("copies fusion coefficients before the SDK wait and leaves belief/version state unchanged", async () => {
  const f = await fact("needle", 0);
  const input = { ...weighted, weights: { ...weights } };
  const normal = model.embedding.getMockImplementation()!;
  model.embedding.mockImplementationOnce(async (args) => {
    input.weights.vector = 0;
    input.weights.keyword = 1;
    return normal(args);
  });
  const before =
    await t.sql`select row_to_json(b) as belief,row_to_json(v) as version from beliefs b join belief_versions v on v.belief_id=b.id where b.id=${f.b}`;
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options(input));
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${r.traceId}`;
  expect(trace!.candidates[0].rankFusion.weights).toEqual(weights);
  expect(
    await t.sql`select row_to_json(b) as belief,row_to_json(v) as version from beliefs b join belief_versions v on v.belief_id=b.id where b.id=${f.b}`,
  ).toEqual(before);
});
it("bounded pools cap trace entries and stable ranks are retained after hydration", async () => {
  await fact("needle", 0);
  await fact("needle", 0);
  await fact("needle", 0);
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ ...rrf, perRouteLimit: 1, maxCandidates: 1 }),
  );
  expect(r.candidates).toHaveLength(1);
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${r.traceId}`;
  expect(trace!.candidates).toHaveLength(1);
  expect(
    trace!.candidates[0].rankFusion.components.every((c: { rank: number }) => c.rank === 1),
  ).toBe(true);
});
it("read-only score hydration completes inside a real PostgreSQL read-only transaction", async () => {
  const f = await fact("needle", 0);
  const result = await t.db.transaction(
    async (tx) => {
      expect((await tx.execute(sql`show transaction_read_only`))[0]?.transaction_read_only).toBe(
        "on",
      );
      return readFusedCandidates(
        tx,
        p,
        "needle",
        snapshot().flags,
        { ...rrf, k: 60, perRouteLimit: 200, maxCandidates: 200 },
        { model: "embed", vector: [1, ...Array(1023).fill(0)] },
      );
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
  expect(result.candidates.map((c) => c.beliefVersionId)).toEqual([f.v]);
});
it.each([
  { fusion: { mode: "rrf" } },
  { fusion: null },
  { fusion: rrf, threshold: 0.3 },
  { fusion: rrf, topK: 0 },
  { fusion: rrf, topK: NaN },
  { fusion: rrf, topK: 201 },
])("invalid experiment %# fails before DB reads/model/trace writes", async (extra) => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error("DB tripwire");
    },
  });
  await expect(retrieve(db, TEST_MASTER_KEY, p, "needle", { ...extra })).rejects.toThrow(
    "INVALID_RUNTIME_FUSION_OPTIONS",
  );
  expect(reads).toBe(0);
});
it("ranking and content hydration issue one SELECT, eliminating a cross-statement current-version race", async () => {
  const f = await fact("needle", 0);
  const execute = vi.spyOn(t.db, "execute");
  try {
    const r = await readFusedCandidates(
      t.db,
      p,
      "needle",
      snapshot().flags,
      { ...rrf, k: 60, perRouteLimit: 200, maxCandidates: 200 },
      { model: "embed", vector: [1, ...Array(1023).fill(0)] },
    );
    expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([f.v]);
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    execute.mockRestore();
  }
});
