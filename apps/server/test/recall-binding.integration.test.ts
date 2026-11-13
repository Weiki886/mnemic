import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { RecallResultSchema } from "@mnemic/shared/memory";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { readFeatureFlags, updateFeatureFlags } from "../src/flags/repository.js";
import { createRerankerProvider } from "../src/providers/reranker.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { createModelQuota } from "../src/quota/repository.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb, endpoint: string;
const project = uuidv7(),
  foreign = uuidv7(),
  token = "offline-recall-binding-token-00000000";
const apps: FastifyInstance[] = [],
  providers: string[] = [],
  seen: { text_1: string; text_2: string[] }[] = [];
let failScore = false;
const score = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const wire = JSON.parse(body) as { text_1: string; text_2: string[] };
    seen.push(wire);
    if (failScore) {
      res.writeHead(500);
      res.end("offline-private-provider-error");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        model: "Qwen/Qwen3-Reranker-0.6B",
        data: wire.text_2.map((text, index) => ({
          object: "score",
          index,
          score: text.includes("preferred") ? 0.9 : 0.1,
        })),
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }),
    );
  });
});
const binding = () => ({ fusion: { mode: "rrf", threshold: 0.001 }, rerankerProvider: {} });
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
  await t.sql`insert into projects(id,name) values(${project},'recall binding'),(${foreign},'foreign')`;
  await new Promise<void>((resolve) => score.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(score.address() as AddressInfo).port}`;
}, 180000);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  seen.length = 0;
  failScore = false;
  await t.sql`update feature_flags set revision=0,flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb where scope='server'`;
  await t.sql`delete from retrieval_traces`;
  await t.sql`delete from model_usage`;
  await t.sql`delete from model_daily_quota`;
  await t.sql`update beliefs set current_version_id=null`;
  await t.sql`delete from belief_versions`;
  await t.sql`delete from beliefs`;
  for (const id of providers.splice(0)) {
    await t.sql`delete from audit_log where target=${id}`;
    await t.sql`delete from provider_configs where id=${id}`;
  }
});
afterAll(async () => {
  score.closeAllConnections();
  await new Promise<void>((resolve) => score.close(() => resolve()));
  await t?.close();
});
async function store(on: boolean) {
  const before = await readFeatureFlags(t.db);
  return updateFeatureFlags(t.db, {
    expected_revision: before.revision,
    flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, reranker: on },
  });
}
async function provider() {
  const row = await createRerankerProvider(t.db, TEST_MASTER_KEY, {
    name: uuidv7(),
    base_url: endpoint,
    api_key: "offline-score-key",
    config: { endpoint_path: "/score", timeout_ms: 2000 },
  });
  providers.push(row.provider_id);
  return row.provider_id;
}
async function fact(value = "needle", scope = project) {
  const b = uuidv7(),
    v = uuidv7();
  await t.sql`insert into beliefs(id,project_id,subject,attribute) values(${b},${scope},${b},'database')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${v},${b},${JSON.stringify(value)}::jsonb,'2020-01-01','2020-01-01')`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  return v;
}
async function start(extra: Record<string, unknown> = {}) {
  const app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    modelDailyCallLimit: 100,
    authToken: token,
    logStream: { write() {} },
    recallBinding: binding(),
    ...extra,
  } as never);
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  return app;
}
const request = (
  app: FastifyInstance,
  path = project,
  body: unknown = { query: "needle" },
  authenticated = true,
  extraHeaders: Record<string, string> = {},
) =>
  fetch(`${app.listeningOrigin}/projects/${path}/recall`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
it.each([
  binding(),
  {
    fusion: {
      mode: "weighted",
      weights: { vector: 0.7, keyword: 0.3, entity: 0, time: 0 },
      threshold: 0.1,
    },
    rerankerProvider: {},
  },
])(
  "trusted %j binding reaches persisted Score API over real HTTP, projects only public trace fields and records metered usage",
  async (config) => {
    const providerId = await provider();
    const ordinary = await fact("needle ordinary"),
      preferred = await fact("needle preferred");
    await fact("needle foreign-private", foreign);
    await store(true);
    const app = await start({ recallBinding: config });
    const response = await request(app);
    expect(response.status).toBe(200);
    const raw = await response.json();
    const result = RecallResultSchema.parse(raw);
    expect(result.candidates.map((c) => c.beliefVersionId)).toEqual([preferred, ordinary]);
    expect(result.trace.reinforce_enabled).toBe(false);
    expect(result.trace.flags_snapshot?.flags.reranker).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text_2).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain("foreign-private");
    const [trace] =
      await t.sql`select candidates from retrieval_traces where id=${result.trace.id}`;
    expect(trace?.candidates[0].reranker.provider).toEqual({ providerId, revision: 0 });
    expect(trace?.candidates[0].rankFusion.mode).toBe(config.fusion.mode);
    expect(Object.keys(result.trace.candidates[0]!).sort()).toEqual(
      ["beliefVersionId", "vectorScore", "keywordScore", "fusedScore", "selected", "reason"].sort(),
    );
    const usage =
      await t.sql`select project_id,conversation_id,slot,purpose,status,prompt_tokens from model_usage`;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      project_id: project,
      conversation_id: null,
      slot: "reranker",
      purpose: "rerank",
      status: "success",
      prompt_tokens: "7",
    });
    expect(JSON.stringify(raw)).not.toContain("offline-score-key");
    expect(JSON.stringify(raw)).not.toContain(endpoint);
  },
);
it("off stored flag retains the configured fusion without resolving a corrupt Provider or invoking Score", async () => {
  const id = await provider();
  await t.sql`update provider_configs set api_key_encrypted='corrupt' where id=${id}`;
  await fact();
  await store(false);
  const app = await start();
  const response = await request(app);
  expect(response.status).toBe(200);
  const result = RecallResultSchema.parse(await response.json());
  expect(result.abstained).toBe(false);
  expect(result.trace.flags_snapshot?.flags.reranker).toBe(false);
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${result.trace.id}`;
  expect(trace?.candidates[0].rankFusion.mode).toBe("rrf");
  expect(seen).toHaveLength(0);
  expect(await t.sql`select id from model_usage`).toHaveLength(0);
});
it.each(["missing", "corrupt"])(
  "enabled %s Provider fails closed with no invocation or success trace",
  async (mode) => {
    if (mode === "corrupt") {
      const id = await provider();
      await t.sql`update provider_configs set api_key_encrypted='corrupt' where id=${id}`;
    }
    await fact();
    await store(true);
    const response = await request(await start());
    expect(response.status).toBe(500);
    expect(seen).toHaveLength(0);
    expect(await t.sql`select id from model_usage`).toHaveLength(0);
    expect(await t.sql`select id from retrieval_traces`).toHaveLength(0);
  },
);
it("a provider failure keeps fusion fallback, writes error usage and hides all internal failure metadata", async () => {
  await provider();
  await fact();
  await store(true);
  failScore = true;
  const response = await request(await start());
  expect(response.status).toBe(200);
  const raw = await response.json();
  expect(RecallResultSchema.parse(raw).abstained).toBe(false);
  expect(JSON.stringify(raw)).not.toContain("offline-private");
  expect(JSON.stringify(raw)).not.toContain("RERANK_FAILED");
  expect(seen).toHaveLength(1);
  const [usage] = await t.sql`select status from model_usage`;
  expect(usage?.status).toBe("error");
});
it("exhausted daily quota denies Score before invocation without pretending retrieval succeeded", async () => {
  await provider();
  await fact();
  await store(true);
  await createModelQuota(t.db, 1, { warn() {} })();
  const response = await request(await start({ modelDailyCallLimit: 1 }));
  expect(response.status).toBe(500); // Existing recall catches failures into its fixed problem response.
  expect(seen).toHaveLength(0);
  expect(await t.sql`select id from model_usage`).toHaveLength(0);
  expect(await t.sql`select id from retrieval_traces`).toHaveLength(0);
});
it.each(["rrf", "weighted"])(
  "%s binding values are captured at registration and HTTP input cannot override them",
  async (mode) => {
    const id = await provider();
    await fact();
    await store(true);
    const config = {
      fusion:
        mode === "weighted"
          ? { mode, threshold: 0.1, weights: { vector: 0.7, keyword: 0.3, entity: 0, time: 0 } }
          : { mode, threshold: 0.001 },
      rerankerProvider: { providerId: id },
    };
    const app = await start({ recallBinding: config });
    config.fusion.threshold = 1;
    if (config.fusion.weights) config.fusion.weights.keyword = 0;
    config.rerankerProvider.providerId = uuidv7();
    const forbidden = await request(app, project, { query: "needle", rerankerProvider: {} });
    expect(forbidden.status).toBe(400);
    expect(seen).toHaveLength(0);
    const result = await request(app);
    expect(result.status).toBe(200);
    expect(RecallResultSchema.parse(await result.json()).abstained).toBe(false);
    expect(seen).toHaveLength(1);
  },
);
it.each(["unauthenticated", "missing-project", "origin", "invalid-project"])(
  "%s rejects before scoring",
  async (mode) => {
    await provider();
    await fact();
    await store(true);
    const response = await request(
      await start(),
      mode === "missing-project" ? uuidv7() : mode === "invalid-project" ? "bad" : project,
      { query: "needle" },
      mode !== "unauthenticated",
      mode === "origin" ? { origin: "https://untrusted.invalid" } : {},
    );
    expect(response.status).toBe(
      { unauthenticated: 401, "missing-project": 404, origin: 403, "invalid-project": 400 }[mode]!,
    );
    expect(seen).toHaveLength(0);
    expect(await t.sql`select id from model_usage`).toHaveLength(0);
  },
);
it("omitting the library binding keeps legacy HTTP recall and produces no fusion metadata", async () => {
  await fact();
  await store(false);
  const response = await request(await start({ recallBinding: undefined }));
  expect(response.status).toBe(200);
  const result = RecallResultSchema.parse(await response.json());
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${result.trace.id}`;
  expect(trace?.candidates[0]).not.toHaveProperty("rankFusion");
  expect(seen).toHaveLength(0);
});
