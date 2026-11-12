import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { retrieve, type RetrieveOptions } from "../src/retrieval/search.js";
import { createRerankerProvider } from "../src/providers/reranker.js";
import { createFeatureFlagSnapshot, DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
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
  { flagsSnapshot: undefined },
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
