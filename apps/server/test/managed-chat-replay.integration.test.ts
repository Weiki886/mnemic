import { resolveStartupRetrievalBindings } from "../src/retrieval/startup-binding.js";
import { beforeAll, afterAll, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import { createFeatureFlagSnapshot, DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { createProvider } from "../src/providers/repository.js";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb;
const prompts: string[] = [];
const model = new MockLanguageModelV2({
  doGenerate: async (options) => {
    prompts.push(JSON.stringify(options.prompt));
    return {
      content: [{ type: "text", text: "offline answer" }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    };
  },
  doStream: async (options) => {
    prompts.push(JSON.stringify(options.prompt));
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "a" });
          controller.enqueue({ type: "text-delta", id: "a", delta: "offline answer" });
          controller.enqueue({ type: "text-end", id: "a" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    };
  },
});
const factory = {
  languageModel: () => model,
  embeddingModel: () => {
    throw Error("offline embedding forbidden");
  },
};
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "offline",
    protocol: "openai-compatible",
    baseUrl: "http://example.invalid/v1",
    apiKey: "offline-fake-key",
    models: { chat: "offline" },
  });
}, 60000);
afterAll(async () => {
  await t?.close();
});
const flags = (enabled = true) =>
  createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 0,
    flags: {
      ...DEFAULT_FEATURE_FLAGS,
      retrieval_vector: false,
      authority_resolution: false,
      read_time_resolution: enabled,
    },
  });
async function fixture(projectId?: string, attribute = "database") {
  const p = projectId ?? uuidv7(),
    b = uuidv7(),
    v = uuidv7(),
    old = uuidv7(),
    next = uuidv7(),
    c = uuidv7(),
    e1 = uuidv7(),
    e2 = uuidv7();
  if (!projectId) await t.sql`insert into projects(id,name) values(${p},'runtime replay')`;
  await t.sql`insert into conversations(id,project_id) values(${c},${p})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${e1},${c},'user','offline',now()),(${e2},${c},'user','offline',now())`;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,recorded_at,evidence_id)
 values(${old},${p},'fact','app',${attribute},'"needle PostgreSQL"','ASSERT','USER_CORRECTION',70,'2025-01-01Z',${e1}),
 (${next},${p},'fact','app',${attribute},'"SQLite private-value-sentinel"','UPDATE','PROJECT_FILE',50,'2025-02-01Z',${e2})`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,salience) values(${b},${p},'app',${attribute},'0.400')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,source_observation_id) values(${v},${b},'"needle PostgreSQL"','2025-01-01Z','2025-01-01Z',${old})`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  return { p, b, v, old, next, e1, e2, c };
}
it.each(["json", "sse", "off", "startup"])(
  "trusted managed %s binding loads persisted flags and real replay without retrieveFn",
  async (mode) => {
    const f = await fixture();
    prompts.length = 0;
    const saved = flags(mode !== "off");
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb`;
    const binding = {
      fusion: { mode: "rrf", threshold: 0.001 },
      rerankerProvider: {},
      readTimeResolution: true,
    };
    const app = buildApp({
      auth: false,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      providerFactory: factory,
      modelDailyCallLimit: 100,
      ...(mode === "startup"
        ? resolveStartupRetrievalBindings(
            JSON.stringify({
              fusion: binding.fusion,
              rerankerProvider: binding.rerankerProvider,
              chatReadTimeResolution: true,
            }),
            { databaseConfigured: true, masterKey: TEST_MASTER_KEY },
          )
        : { chatRetrievalBinding: binding }),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url:
          mode !== "sse"
            ? `/projects/${f.p}/conversations/${f.c}/messages`
            : `/projects/${f.p}/conversations/${f.c}/messages/stream`,
        payload: { text: "needle" },
      });
      expect(response.statusCode).toBe(200);
      const reply =
        mode !== "sse"
          ? response.json()
          : response.body
              .split("\n")
              .filter((s) => s.startsWith("data:"))
              .map((s) => JSON.parse(s.slice(5)))
              .find((e) => e.type === "finish");
      if (mode === "off") {
        expect(reply.memories[0]).toMatchObject({
          belief_version_id: f.v,
          value: "needle PostgreSQL",
        });
        expect(prompts[0]).not.toContain("SQLite");
      } else {
        expect(reply.memories[0]).toMatchObject({
          belief_version_id: null,
          value: "SQLite private-value-sentinel",
          provenance: { observation_id: f.next, evidence_id: f.e2 },
        });
        expect(prompts[0]).toContain("SQLite");
        expect(prompts[0]).not.toContain("PostgreSQL");
      }
    } finally {
      await app.close();
    }
  },
);
