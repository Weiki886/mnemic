import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { retrieve, type RetrieveOptions } from "../src/retrieval/search.js";
import { createRerankerProvider } from "../src/providers/reranker.js";
import { createFeatureFlagSnapshot, DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import * as flagRepository from "../src/flags/repository.js";
import * as rerankerRepository from "../src/providers/reranker.js";
import { createProvider } from "../src/providers/repository.js";
import { durableModels } from "./fixtures/durable-models.js";
let t: TestDb;
const p = uuidv7(),
  owned: string[] = [],
  calls: { url: string; auth: string | null }[] = [];
const admit = vi.fn(async () => {}),
  model = "Qwen/Qwen3-Reranker-0.6B";
const flags = (on = true) =>
  createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, reranker: on },
  });
const options = (extra: Partial<RetrieveOptions> = {}) => ({
  flagsSnapshot: flags(),
  fusion: { mode: "rrf", threshold: 0.001 },
  rerankerProvider: {},
  admitModelCall: admit,
  topK: 1,
  ...extra,
});
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
  expect(new URL(t.url).pathname).not.toBe("/mnemic_test");
  await t.sql`insert into projects(id,name) values(${p},'isolated binding')`;
}, 180000);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  admit.mockClear();
  calls.length = 0;
  await t.sql`update feature_flags set revision=0,flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb where scope='server'`;
  await t.sql`delete from retrieval_traces`;
  await t.sql`delete from model_usage`;
  await t.sql`update beliefs set current_version_id=null`;
  await t.sql`delete from belief_versions`;
  await t.sql`delete from beliefs`;
  for (const id of owned.splice(0)) {
    await t.sql`delete from audit_log where target=${id}`;
    await t.sql`delete from provider_configs where id=${id}`;
  }
});
afterAll(async () => {
  await t?.close();
});
async function provider(host = "first.invalid", time = "2020-01-01", disabled = false) {
  const row = await createRerankerProvider(t.db, TEST_MASTER_KEY, {
    name: uuidv7(),
    base_url: `https://${host}/v1`,
    api_key: `offline-${host}-key`,
    config: { endpoint_path: "/score", timeout_ms: 5000 },
  });
  owned.push(row.provider_id);
  await t.sql`update provider_configs set created_at=${time}::timestamptz where id=${row.provider_id}`;
  if (disabled)
    await t.sql`update provider_configs set reranker_config='{"revision":1,"config":null}'::jsonb where id=${row.provider_id}`;
  return row.provider_id;
}
async function fact(value = "needle") {
  const b = uuidv7(),
    v = uuidv7();
  await t.sql`insert into beliefs(id,project_id,subject,attribute,salience) values(${b},${p},${b},'db',0.5)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${v},${b},${JSON.stringify(value)}::jsonb,'2020-01-01','2020-01-01')`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  return v;
}
function transport(before?: () => Promise<void>) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      const body = JSON.parse(init?.body as string);
      await before?.();
      return Response.json({
        object: "list",
        model,
        data: body.text_2.map((_: unknown, index: number) => ({
          object: "score",
          index,
          score: (index + 1) / (body.text_2.length + 1),
        })),
        usage: { prompt_tokens: 7, total_tokens: 7 },
      });
    }),
  );
}
it("automatic selection orders created_at/id and records only provider ID/revision", async () => {
  const a = await provider();
  await provider("second.invalid");
  await provider("disabled.invalid", "2000-01-01", true);
  await fact();
  const second = await fact();
  transport();
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options());
  expect(r.candidates[0]?.beliefVersionId).toBe(second);
  expect(calls).toEqual([
    { url: "https://first.invalid/score", auth: "Bearer offline-first.invalid-key" },
  ]);
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${r.traceId}`;
  expect(trace?.candidates[0].reranker.provider).toEqual({ providerId: a, revision: 0 });
  expect(JSON.stringify(trace?.candidates)).not.toContain("first.invalid");
  expect(admit).toHaveBeenCalledTimes(1);
});
it("explicit ID wins over automatic ordering", async () => {
  await provider();
  const b = await provider("second.invalid", "2030-01-01");
  await fact();
  transport();
  await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ rerankerProvider: { providerId: b } }),
  );
  expect(calls[0]?.url).toBe("https://second.invalid/score");
});
it.each(["missing", "disabled", "corrupt"])(
  "explicit %s never switches to a healthy provider",
  async (mode) => {
    const a = await provider();
    await provider("healthy.invalid");
    await fact();
    if (mode === "disabled")
      await t.sql`update provider_configs set reranker_config='{"revision":1,"config":null}'::jsonb where id=${a}`;
    if (mode === "corrupt")
      await t.sql`update provider_configs set api_key_encrypted='private-bad' where id=${a}`;
    transport();
    await expect(
      retrieve(
        t.db,
        TEST_MASTER_KEY,
        p,
        "needle",
        options({ rerankerProvider: { providerId: mode === "missing" ? uuidv7() : a } }),
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(admit).not.toHaveBeenCalled();
    expect(await t.sql`select id from retrieval_traces`).toHaveLength(0);
  },
);
it("corrupt automatic winner fails closed", async () => {
  const a = await provider();
  await provider("healthy.invalid");
  await t.sql`update provider_configs set api_key_encrypted='bad' where id=${a}`;
  await fact();
  transport();
  await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", options())).rejects.toThrow(
    "RERANKER_CONFIG_UNAVAILABLE",
  );
  expect(calls).toHaveLength(0);
});
it.each(["off", "empty", "refused", "oversized"])(
  "%s does not select/decrypt or call a provider",
  async (mode) => {
    await provider();
    if (mode !== "empty")
      await fact(mode === "oversized" ? "needle " + "x".repeat(17000) : "needle");
    transport();
    const original = t.db.select.bind(t.db);
    let reads = 0;
    vi.spyOn(t.db, "select").mockImplementation((...args: Parameters<typeof original>) => {
      reads++;
      return original(...args);
    });
    const r = await retrieve(
      t.db,
      TEST_MASTER_KEY,
      p,
      "needle",
      options({
        flagsSnapshot: flags(mode !== "off"),
        fusion: { mode: "rrf", threshold: mode === "refused" ? 1 : 0.001 },
      }),
    );
    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
    expect(admit).not.toHaveBeenCalled();
    expect(r.abstained).toBe(mode === "empty" || mode === "refused");
  },
);
it("no configured provider refuses without a success trace", async () => {
  await fact();
  transport();
  await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", options())).rejects.toThrow(
    "RERANKER_PROVIDER_UNCONFIGURED",
  );
  expect(calls).toHaveLength(0);
});
it.each([
  { reranker: { endpoint: "https://raw.invalid/score" } },
  { fusion: undefined },
  { rerankerProvider: { providerId: "bad" } },
  { rerankerProvider: { api_key: "secret" } },
  {
    flagsSnapshot: undefined,
    rerankerProvider: undefined,
    reranker: { endpoint: "https://raw.invalid/score" },
  },
  { admitModelCall: undefined },
])("invalid binding rejects before DB %j", async (extra) => {
  const db = new Proxy(t.db, {
    get() {
      throw Error("DB touched");
    },
  });
  await expect(retrieve(db, TEST_MASTER_KEY, p, "needle", options(extra as never))).rejects.toThrow(
    "INVALID_RUNTIME_RERANK_OPTIONS",
  );
});

it("selection metadata and credential remain the original snapshot when config changes during scoring", async () => {
  const a = await provider();
  await fact();
  transport(async () => {
    await t.sql`update provider_configs set api_key_encrypted='changed-key',base_url='https://changed.invalid',reranker_config='{"revision":1,"config":{"endpoint_path":"/v1/score","timeout_ms":1000}}'::jsonb where id=${a}`;
  });
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options());
  expect(calls[0]?.auth).toBe("Bearer offline-first.invalid-key");
  const [row] = await t.sql`select candidates from retrieval_traces where id=${r.traceId}`;
  expect(row?.candidates[0].reranker.provider).toEqual({ providerId: a, revision: 0 });
});
it("provider descriptor is copied before the first asynchronous wait", async () => {
  const a = await provider(),
    b = await provider("second.invalid");
  await fact();
  transport();
  const descriptor = { providerId: a };
  const pending = retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ rerankerProvider: descriptor }),
  );
  descriptor.providerId = b;
  await pending;
  expect(calls[0]?.url).toBe("https://first.invalid/score");
});

// Persisted Provider bindings may use the same stored snapshot as ordinary retrieval.
const storedOptions = (extra: Partial<RetrieveOptions> = {}) => {
  const { flagsSnapshot: _snapshot, ...input } = options(extra);
  return input;
};
async function stored(on: boolean, extra: Partial<typeof DEFAULT_FEATURE_FLAGS> = {}) {
  const before = await flagRepository.readFeatureFlags(t.db);
  const result = await flagRepository.updateFeatureFlags(t.db, {
    expected_revision: before.revision,
    flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, reranker: on, ...extra },
  });
  return result.snapshot;
}
it.each([false, true])(
  "stored reranker=%s controls scoring and persists the exact effective snapshot",
  async (on) => {
    await provider();
    await fact();
    const snapshot = await stored(on);
    const read = vi.spyOn(flagRepository, "readFeatureFlags");
    const select = vi.spyOn(rerankerRepository, "resolveConfiguredRerankerConfig");
    transport();
    const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", storedOptions());
    const [row] = await t.sql`select flags_snapshot from retrieval_traces where id=${r.traceId}`;
    expect(row?.flags_snapshot).toEqual(snapshot);
    expect(read).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(calls).toHaveLength(on ? 1 : 0);
    expect(admit).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(r.abstained).toBe(false);
  },
);
it.each([false, true])(
  "an explicit trusted snapshot wins over the opposite stored flag (%s)",
  async (on) => {
    await provider();
    await fact();
    await stored(!on);
    const read = vi.spyOn(flagRepository, "readFeatureFlags");
    transport();
    const input = flags(on);
    const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options({ flagsSnapshot: input }));
    const [row] = await t.sql`select flags_snapshot from retrieval_traces where id=${r.traceId}`;
    expect(row?.flags_snapshot).toEqual(input);
    expect(read).not.toHaveBeenCalled();
    expect(calls).toHaveLength(on ? 1 : 0);
  },
);
it.each([false, true])(
  "a stored flag changed during embedding affects only the next operation (initial=%s)",
  async (on) => {
    await provider();
    await fact();
    const embeddingProvider = await createProvider(t.db, TEST_MASTER_KEY, {
      name: uuidv7(),
      protocol: "openai-compatible",
      baseUrl: "https://embedding.invalid",
      apiKey: "offline-embedding",
      models: { embedding: "offline-vector" },
    });
    owned.push(embeddingProvider.id);
    const initial = await stored(on, { retrieval_vector: true });
    const models = durableModels();
    const embedResult = { embeddings: [[1, ...Array(1023).fill(0)]], usage: { tokens: 3 } };
    let changed: typeof initial | undefined;
    models.embedding.mockImplementationOnce(async () => {
      changed = await stored(!on, { retrieval_vector: true });
      return embedResult;
    });
    transport();
    const first = await retrieve(
      t.db,
      TEST_MASTER_KEY,
      p,
      "needle",
      storedOptions({ factory: models.factory }),
    );
    const [a] = await t.sql`select flags_snapshot from retrieval_traces where id=${first.traceId}`;
    expect(a?.flags_snapshot).toEqual(initial);
    expect(calls).toHaveLength(on ? 1 : 0);
    const next = await retrieve(
      t.db,
      TEST_MASTER_KEY,
      p,
      "needle",
      storedOptions({ factory: models.factory }),
    );
    const [b] = await t.sql`select flags_snapshot from retrieval_traces where id=${next.traceId}`;
    expect(b?.flags_snapshot).toEqual(changed);
    expect(calls).toHaveLength(1);
    expect(models.embedding).toHaveBeenCalledTimes(2);
  },
);
it.each(["decay", "read_time_resolution"] as const)(
  "stored unsupported %s rejects before any model or Provider lookup",
  async (key) => {
    await provider();
    await fact();
    await stored(true, { [key]: true });
    const select = vi.spyOn(rerankerRepository, "resolveConfiguredRerankerConfig");
    transport();
    await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", storedOptions())).rejects.toThrow(
      "unsupported feature flag enabled",
    );
    expect(select).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(admit).not.toHaveBeenCalled();
    expect(await t.sql`select id from retrieval_traces`).toHaveLength(0);
  },
);
it("a missing persisted singleton fails closed before Provider access or paid admission", async () => {
  await provider();
  await fact();
  // Remove and restore only this fixture's private singleton, preserving every column.
  const [saved] =
    await t.sql`delete from feature_flags returning id,scope,schema_version,revision,flags,updated_at::text`;
  const select = vi.spyOn(rerankerRepository, "resolveConfiguredRerankerConfig");
  transport();
  try {
    await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", storedOptions())).rejects.toThrow(
      "invalid feature flag configuration",
    );
    expect(select).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(admit).not.toHaveBeenCalled();
  } finally {
    await t.sql`insert into feature_flags(id,scope,schema_version,revision,flags,updated_at) values(${saved!.id},${saved!.scope},${saved!.schema_version},${saved!.revision},${JSON.stringify(saved!.flags)}::jsonb,${saved!.updated_at})`;
  }
});
it("the stored on flag does not grant an unbound retrieval caller a reranker capability", async () => {
  await stored(true);
  transport();
  await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle")).rejects.toThrow(
    "unsupported feature flag enabled",
  );
  expect(calls).toHaveLength(0);
});
it.each([false, true])(
  "without a configured Provider, stored on=%s keeps the off path usable and the on path closed",
  async (on) => {
    await fact();
    await stored(on);
    transport();
    const result = retrieve(t.db, TEST_MASTER_KEY, p, "needle", storedOptions());
    if (on) await expect(result).rejects.toThrow("RERANKER_PROVIDER_UNCONFIGURED");
    else expect((await result).abstained).toBe(false);
    expect(calls).toHaveLength(0);
    expect(admit).not.toHaveBeenCalled();
  },
);
it.each([null, false, 0])(
  "an explicit malformed snapshot %s never falls back to the stored configuration",
  async (input) => {
    const db = new Proxy(t.db, {
      get() {
        throw Error("database touched");
      },
    });
    await expect(
      retrieve(db, TEST_MASTER_KEY, p, "needle", options({ flagsSnapshot: input as never })),
    ).rejects.toMatchObject({ name: "ZodError" });
  },
);
