import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { retrieve } from "../src/retrieval/search.js";
import { readFeatureFlags, updateFeatureFlags } from "../src/flags/repository.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { durableModels } from "./fixtures/durable-models.js";
let t: TestDb, saved: Awaited<ReturnType<typeof readFeatureFlags>>;
const model = durableModels();
beforeAll(async () => {
  t = await setupTestDb();
  saved = await readFeatureFlags(t.db);
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "flags-retrieval",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { embedding: "embed" },
  });
}, 180000);
beforeEach(async () => {
  vi.stubEnv("MNEMIC_READ_REINFORCE", undefined);
  model.embedding.mockClear();
  await t.sql`update feature_flags set flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb,revision=0 where scope='server'`;
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (t) {
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb,revision=${saved.revision} where scope='server'`;
    await t.close();
  }
});
async function configure(flags: Partial<typeof DEFAULT_FEATURE_FLAGS>) {
  const current = await readFeatureFlags(t.db);
  return (
    await updateFeatureFlags(t.db, {
      expected_revision: current.revision,
      flags: { ...current.flags, ...flags },
    })
  ).snapshot;
}
async function seed(indexed = true) {
  const p = uuidv7(),
    b = uuidv7(),
    v = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'flags retrieval')`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,salience) values(${b},${p},'flags-project','database',0.5)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${v},${b},'"PostgreSQL"',now(),now())`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  if (indexed)
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${v},${"[" + [1, ...Array(1023).fill(0)].join(",") + "]"}::vector,'embed')`;
  return { p, b, v };
}
const options = { factory: model.factory, threshold: 0.1 };
it("vector off sends zero query embeddings but keyword recall and snapshot remain real", async () => {
  const f = await seed(),
    snapshot = await configure({ retrieval_vector: false });
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "PostgreSQL", options);
  expect(model.embedding).not.toHaveBeenCalled();
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0]!.vectorScore).toBeNull();
  const [trace] = await t.sql`select flags_snapshot from retrieval_traces where id=${r.traceId}`;
  expect(trace!.flags_snapshot).toEqual(snapshot);
});
it("keyword off stops keyword-only facts; vector-only scores still work", async () => {
  const f = await seed(false);
  await configure({ retrieval_keyword: false });
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "PostgreSQL", options);
  expect(r.abstained).toBe(true);
  expect(r.candidates).toHaveLength(0);
  expect(model.embedding).toHaveBeenCalledOnce();
});
it("both retrieval routes off abstain without any embedding invocation", async () => {
  const f = await seed();
  await configure({ retrieval_vector: false, retrieval_keyword: false });
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "PostgreSQL", options);
  expect(r.abstained).toBe(true);
  expect(r.candidates).toEqual([]);
  expect(model.embedding).not.toHaveBeenCalled();
});
it("stored reinforcement toggles salience and agrees with both trace fields", async () => {
  const f = await seed();
  const snapshot = await configure({ read_time_reinforcement: true });
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "PostgreSQL", options);
  expect(Number((await t.sql`select salience from beliefs where id=${f.b}`)[0]!.salience)).toBe(
    0.55,
  );
  expect(
    (
      await t.sql`select reinforce_enabled,flags_snapshot from retrieval_traces where id=${r.traceId}`
    )[0],
  ).toEqual({ reinforce_enabled: true, flags_snapshot: snapshot });
});
it("trusted reinforce override wins over env/stored config and is materialized in the effective trace", async () => {
  const f = await seed();
  vi.stubEnv("MNEMIC_READ_REINFORCE", "1");
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "PostgreSQL", {
    ...options,
    reinforce: false,
  });
  const [trace] =
    await t.sql`select reinforce_enabled,flags_snapshot from retrieval_traces where id=${r.traceId}`;
  expect(trace!.reinforce_enabled).toBe(false);
  expect(trace!.flags_snapshot.flags.read_time_reinforcement).toBe(false);
  expect(Number((await t.sql`select salience from beliefs where id=${f.b}`)[0]!.salience)).toBe(
    0.5,
  );
});
it("an in-flight SDK callback changing configuration cannot change current operation or its trace", async () => {
  const f = await seed(),
    old = await readFeatureFlags(t.db),
    normal = model.embedding.getMockImplementation()!;
  model.embedding.mockImplementationOnce(async (args) => {
    await configure({ retrieval_vector: false, retrieval_keyword: false });
    return normal(args);
  });
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "semantic other words", options);
  expect(r.candidates).toHaveLength(1);
  expect(
    (await t.sql`select flags_snapshot from retrieval_traces where id=${r.traceId}`)[0]!
      .flags_snapshot,
  ).toEqual(old);
  model.embedding.mockClear();
  const next = await retrieve(t.db, TEST_MASTER_KEY, f.p, "PostgreSQL", options);
  expect(next.abstained).toBe(true);
  expect(model.embedding).not.toHaveBeenCalled();
});
it("unsupported configuration fails before paid calls or retrieval trace creation", async () => {
  const f = await seed();
  await configure({ reranker: true });
  await expect(retrieve(t.db, TEST_MASTER_KEY, f.p, "PostgreSQL", options)).rejects.toThrow(
    "unsupported feature flag enabled",
  );
  expect(model.embedding).not.toHaveBeenCalled();
  expect(await t.sql`select * from retrieval_traces where project_id=${f.p}`).toHaveLength(0);
});
it("legacy traces retain unknown snapshot rather than receiving fabricated defaults", async () => {
  const f = await seed(),
    id = uuidv7();
  await t.sql`insert into retrieval_traces(id,project_id,query_text,candidates,abstained) values(${id},${f.p},'legacy','[]',true)`;
  expect(
    (await t.sql`select flags_snapshot from retrieval_traces where id=${id}`)[0]!.flags_snapshot,
  ).toBeNull();
});
