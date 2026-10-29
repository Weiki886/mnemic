import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { DEFAULT_FEATURE_FLAGS, FeatureFlagSnapshotSchema } from "@mnemic/shared/flags";
import { buildApp } from "../src/app.js";
import { readFeatureFlags, updateFeatureFlags } from "../src/flags/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  baseUrl: string,
  saved: Awaited<ReturnType<typeof readFeatureFlags>>;
const token = "flags-api-offline-token-0000000000",
  headers = { authorization: `Bearer ${token}` };
const models = vi.fn(() => {
  throw Error("configuration must not invoke models");
});
beforeAll(async () => {
  t = await setupTestDb();
  saved = await readFeatureFlags(t.db);
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    providerFactory: { languageModel: models, embeddingModel: models },
    logStream: { write: () => {} },
  });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
beforeEach(async () => {
  models.mockClear();
  await t.sql`update feature_flags set flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb,revision=0 where scope='server'`;
});
afterAll(async () => {
  await app?.close();
  if (t) {
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb,revision=${saved.revision} where scope='server'`;
    await t.close();
  }
});
async function audits() {
  return t.sql`select * from audit_log where actor='server' and action='flags.update' and target='server'`;
}
const put = (
  flags: Record<string, boolean> = { ...DEFAULT_FEATURE_FLAGS, memory_gate: false },
  expected_revision = 0,
) =>
  app.inject({
    method: "PUT",
    url: "/v1/config/flags",
    headers,
    payload: { expected_revision, flags },
  });
it("GET returns persisted configuration; PUT returns durable revision and complete audit once", async () => {
  const before = await audits();
  const get = await app.inject({ url: "/v1/config/flags", headers });
  expect(get.statusCode).toBe(200);
  expect(FeatureFlagSnapshotSchema.parse(get.json())).toEqual({
    schema_version: 1,
    revision: 0,
    flags: DEFAULT_FEATURE_FLAGS,
  });
  expect(get.headers["cache-control"]).toBe("no-store");
  const r = await put();
  expect(r.statusCode).toBe(200);
  expect(r.json().kind).toBe("updated");
  const snapshot = FeatureFlagSnapshotSchema.parse(r.json().snapshot);
  expect(snapshot).toMatchObject({ revision: 1, flags: { memory_gate: false } });
  expect(await readFeatureFlags(t.db)).toEqual(snapshot);
  const fresh = (await audits()).filter((r) => !before.some((b) => r.id === b.id));
  expect(fresh).toHaveLength(1);
  expect(fresh[0]!.meta).toEqual({
    schema_version: 1,
    previous_revision: 0,
    revision: 1,
    before: DEFAULT_FEATURE_FLAGS,
    after: { ...DEFAULT_FEATURE_FLAGS, memory_gate: false },
  });
  expect(models).not.toHaveBeenCalled();
});
it("stale revision returns 409 and identical current configuration is a no-op", async () => {
  const before = (await audits()).length;
  expect((await put()).statusCode).toBe(200);
  const stale = await put({ ...DEFAULT_FEATURE_FLAGS });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("CONFLICT");
  expect(stale.json().errors[0].path).toBe("expected_revision");
  const noOp = await put({ ...DEFAULT_FEATURE_FLAGS, memory_gate: false }, 1);
  expect(noOp.statusCode).toBe(200);
  expect(noOp.json().kind).toBe("unchanged");
  expect(noOp.json().snapshot.revision).toBe(1);
  expect((await audits()).length).toBe(before + 1);
});
it("eight same-revision HTTP requests admit exactly one mutation and one audit", async () => {
  const before = (await audits()).length;
  const results = await Promise.all(Array.from({ length: 8 }, () => put()));
  expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(results.filter((r) => r.statusCode === 409)).toHaveLength(7);
  expect((await audits()).length).toBe(before + 1);
});
it.each([
  "retrieval_entity",
  "retrieval_time",
  "decay",
  "reranker",
  "read_time_resolution",
] as const)("management rejects unsupported %s with no mutation/audit", async (key) => {
  const before = (await audits()).length;
  const r = await put({ ...DEFAULT_FEATURE_FLAGS, [key]: true });
  expect(r.statusCode).toBe(400);
  expect(r.json().errors).toContainEqual({ path: `flags.${key}`, message: expect.any(String) });
  expect(await readFeatureFlags(t.db)).toEqual({
    schema_version: 1,
    revision: 0,
    flags: DEFAULT_FEATURE_FLAGS,
  });
  expect((await audits()).length).toBe(before);
  expect(models).not.toHaveBeenCalled();
});
it("GET can diagnose internal unsupported state and PUT can repair it without invoking runtime consumers", async () => {
  const state = (
    await updateFeatureFlags(t.db, {
      expected_revision: 0,
      flags: { ...DEFAULT_FEATURE_FLAGS, reranker: true },
    })
  ).snapshot;
  const get = await app.inject({ url: "/v1/config/flags", headers });
  expect(get.statusCode).toBe(200);
  expect(get.json()).toEqual(state);
  const r = await put({ ...DEFAULT_FEATURE_FLAGS }, state.revision);
  expect(r.statusCode).toBe(200);
  expect(r.json().snapshot.flags.reranker).toBe(false);
  expect(models).not.toHaveBeenCalled();
});
it("database audit failure rolls HTTP update back and returns safe problem 500", async () => {
  const before = (await audits()).length;
  await t.sql`alter table audit_log add constraint flags_api_test_reject check (action <> 'flags.update') not valid`;
  try {
    const r = await put();
    expect(r.statusCode).toBe(500);
    expect(r.json().code).toBe("INTERNAL_ERROR");
    expect(r.headers["cache-control"]).toBe("no-store");
  } finally {
    await t.sql`alter table audit_log drop constraint flags_api_test_reject`;
  }
  expect((await readFeatureFlags(t.db)).revision).toBe(0);
  expect((await audits()).length).toBe(before);
});
it("exhausted revision has a structured 409 instead of an internal failure", async () => {
  await t.sql`update feature_flags set revision=9007199254740991 where scope='server'`;
  const before = (await audits()).length;
  const r = await put({ ...DEFAULT_FEATURE_FLAGS, memory_gate: false }, Number.MAX_SAFE_INTEGER);
  expect(r.statusCode).toBe(409);
  expect(r.json().code).toBe("CONFLICT");
  expect((await audits()).length).toBe(before);
});
it("content types and query parameter overrides cannot mutate configuration", async () => {
  const before = (await audits()).length;
  const type = await app.inject({
    method: "PUT",
    url: "/v1/config/flags",
    headers: { ...headers, "content-type": "text/plain" },
    payload: JSON.stringify({ expected_revision: 0, flags: DEFAULT_FEATURE_FLAGS }),
  });
  expect(type.statusCode).toBe(415);
  expect(type.headers["content-type"]).toContain("application/problem+json");
  const query = await app.inject({ url: "/v1/config/flags?flags=false", headers });
  expect(query.statusCode).toBe(400);
  expect(query.json().errors.length).toBeGreaterThan(0);
  expect((await audits()).length).toBe(before);
});
it("real HTTP GET/PUT controls actual recall and trace without model calls", async () => {
  const p = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'flags-http')`;
  const get = await fetch(baseUrl + "/v1/config/flags", { headers });
  expect(get.status).toBe(200);
  const current = FeatureFlagSnapshotSchema.parse(await get.json());
  const r = await fetch(baseUrl + "/v1/config/flags", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      expected_revision: current.revision,
      flags: { ...current.flags, retrieval_vector: false, retrieval_keyword: false },
    }),
  });
  expect(r.status).toBe(200);
  const changed = (await r.json()) as { snapshot: unknown };
  const recall = await fetch(baseUrl + `/projects/${p}/recall`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ query: "anything" }),
  });
  expect(recall.status).toBe(200);
  const result = (await recall.json()) as {
    abstained: boolean;
    trace: { flags_snapshot: unknown };
  };
  expect(result.abstained).toBe(true);
  expect(result.trace.flags_snapshot).toEqual(changed.snapshot);
  expect(models).not.toHaveBeenCalled();
});
it("GET reports persisted flags, not environment materialization for individual operations", async () => {
  vi.stubEnv("MNEMIC_READ_REINFORCE", "1");
  try {
    const r = await app.inject({ url: "/v1/config/flags", headers });
    expect(r.statusCode).toBe(200);
    expect(r.json().flags.read_time_reinforcement).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
