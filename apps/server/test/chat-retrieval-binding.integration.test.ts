import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { MockLanguageModelV2 } from "ai/test";
import { createProvider } from "../src/providers/repository.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { readFeatureFlags, updateFeatureFlags } from "../src/flags/repository.js";
import { createRerankerProvider } from "../src/providers/reranker.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb, endpoint: string;
const project = uuidv7(),
  foreign = uuidv7(),
  token = "offline-recall-binding-token-00000000";
const apps: FastifyInstance[] = [],
  providers: string[] = [],
  seen: { text_1: string; text_2: string[] }[] = [];
let failScore = false;
const prompts: string[] = [];
const observe = (prompt: unknown) => {
  prompts.push(JSON.stringify(prompt));
};
const factory = {
  languageModel: () =>
    new MockLanguageModelV2({
      doGenerate: async (input) => {
        observe(input.prompt);
        return {
          content: [{ type: "text" as const, text: "OFFLINE" }],
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
      doStream: async (input) => {
        observe(input.prompt);
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "text-start", id: "a" });
              c.enqueue({ type: "text-delta", id: "a", delta: "OFFLINE" });
              c.enqueue({ type: "text-end", id: "a" });
              c.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              c.close();
            },
          }),
        };
      },
    }),
  embeddingModel: () => {
    throw Error("unexpected embedding");
  },
};
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
  prompts.length = 0;
  await t.sql`delete from model_usage`;
  await t.sql`delete from messages`;
  await t.sql`delete from conversations`;
  failScore = false;
  await t.sql`update feature_flags set revision=0,flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb where scope='server'`;
  await t.sql`delete from retrieval_traces`;
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
    chatRetrievalBinding: binding(),
    providerFactory: factory,
    ...extra,
  } as never);
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  return app;
}

async function conversation() {
  const row = await createProvider(t.db, TEST_MASTER_KEY, {
    name: uuidv7(),
    protocol: "openai-compatible",
    baseUrl: "https://chat.invalid",
    apiKey: "offline-chat",
    models: { chat: "offline-chat" },
  });
  providers.push(row.id);
  const id = uuidv7();
  await t.sql`insert into conversations(id,project_id) values(${id},${project})`;
  return id;
}
async function send(
  app: FastifyInstance,
  id: string,
  stream: boolean,
  body: unknown = { text: "needle" },
  scope = project,
) {
  const response = await fetch(
    `${app.listeningOrigin}/projects/${scope}/conversations/${id}/messages${stream ? "/stream" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  expect(response.status).toBe(200);
  if (stream) expect(text).toContain("finish");
  return text;
}
it.each([false, true].flatMap((stream) => [false, true].map((on) => ({ stream, on }))))(
  "chat binding %j injects selected memory and records physical conversation usage",
  async ({ stream, on }) => {
    await provider();
    const a = await fact("needle ordinary"),
      b = await fact("needle preferred");
    await fact("needle foreign-private", foreign);
    await store(on);
    const id = await conversation(),
      app = await start();
    await send(app, id, stream);
    expect(seen).toHaveLength(on ? 1 : 0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("needle preferred");
    expect(prompts[0]).not.toContain("foreign-private");
    const [answer] =
      await t.sql`select memories from messages where conversation_id=${id} and speaker='assistant'`;
    expect(answer?.memories).toEqual(on ? [b, a] : [a, b]);
    const usage = await t.sql`select slot,conversation_id from model_usage order by slot`;
    expect(usage).toHaveLength(on ? 2 : 1);
    expect(usage.every((r) => r.conversation_id === id)).toBe(true);
    const [trace] = await t.sql`select candidates,flags_snapshot from retrieval_traces`;
    expect(trace?.flags_snapshot.flags.reranker).toBe(on);
    expect(trace?.candidates[0].rankFusion.mode).toBe("rrf");
  },
);
it.each([false, true])("Score failure preserves fusion before chat (stream=%s)", async (stream) => {
  await provider();
  await fact();
  await store(true);
  failScore = true;
  const id = await conversation();
  await send(await start(), id, stream);
  expect(seen).toHaveLength(1);
  expect(prompts[0]).toContain("needle");
  const [u] = await t.sql`select status from model_usage where slot='reranker'`;
  expect(u?.status).toBe("error");
});
it.each([false, true])(
  "startup binding copy and strict message input (stream=%s)",
  async (stream) => {
    const providerId = await provider();
    await fact();
    await store(true);
    const config = { fusion: { mode: "rrf", threshold: 0.001 }, rerankerProvider: { providerId } };
    const id = await conversation(),
      app = await start({ chatRetrievalBinding: config });
    config.fusion.threshold = 1;
    config.rerankerProvider.providerId = uuidv7();
    const bad = await fetch(
      `${app.listeningOrigin}/projects/${project}/conversations/${id}/messages${stream ? "/stream" : ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: "needle", fusion: {} }),
      },
    );
    expect(bad.status).toBe(400);
    expect(seen).toHaveLength(0);
    await send(app, id, stream);
    expect(seen).toHaveLength(1);
    expect(prompts[0]).toContain("needle");
  },
);
it.each([false, true])(
  "missing reranker configuration retains existing no-memory chat degradation (stream=%s)",
  async (stream) => {
    await fact();
    await store(true);
    const id = await conversation();
    await send(await start(), id, stream);
    expect(seen).toHaveLength(0);
    expect(prompts[0]).not.toContain("needle ordinary");
    expect(await t.sql`select id from retrieval_traces`).toHaveLength(0);
    const [answer] =
      await t.sql`select memories from messages where conversation_id=${id} and speaker='assistant'`;
    expect(answer?.memories).toBeNull();
  },
);
