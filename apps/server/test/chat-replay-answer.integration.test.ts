import { beforeAll, afterAll, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import { createFeatureFlagSnapshot, DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { createProvider } from "../src/providers/repository.js";
import { retrieve } from "../src/retrieval/search.js";
import { respondToMessage } from "../src/chat/respond.js";
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
const replay =
  (budget = false, enabled = true): typeof retrieve =>
  (db, mk, p, q, options) =>
    retrieve(db, mk, p, q, {
      ...options,
      fusion: { mode: "rrf", threshold: 0.001 },
      readTimeResolution: true,
      flagsSnapshot: flags(enabled),
      ...(budget
        ? {
            memoryBudget: {
              maxTokens: 0,
              countTokens: (s: string) => (s.includes("SQLite") ? 100 : 0),
            },
          }
        : {}),
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
async function business(p: string) {
  const [r] = await t.sql`select
 (select jsonb_agg(to_jsonb(b) order by id) from beliefs b where project_id=${p}) as beliefs,
 (select jsonb_agg(to_jsonb(v) order by id) from belief_versions v where belief_id in(select id from beliefs where project_id=${p})) as versions,
 (select jsonb_agg(to_jsonb(o) order by id) from observations o where project_id=${p}) as observations`;
  return JSON.stringify(r);
}

it.each(["json", "sse"])("%s injects and persists the same real replay source", async (mode) => {
  const f = await fixture();
  const before = await business(f.p);
  prompts.length = 0;
  let refs: unknown;
  let messageId: string;
  if (mode === "json") {
    const r = await respondToMessage(t.db, TEST_MASTER_KEY, f.p, f.c, "needle", {
      factory,
      retrieveFn: replay(),
      durableExtraction: true,
      onJob: () => {},
    });
    expect(r.kind).toBe("answered");
    if (r.kind !== "answered") throw Error("no answer");
    refs = r.memories;
    messageId = r.messageId;
  } else {
    const app = buildApp({
      auth: false,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      providerFactory: factory,
      chatDeps: { retrieveFn: replay() },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/projects/${f.p}/conversations/${f.c}/messages/stream`,
        payload: { text: "needle" },
      });
      const events = response.body
        .split("\n")
        .filter((s) => s.startsWith("data:"))
        .map((s) => JSON.parse(s.slice(5)));
      const finish = events.find((e) => e.type === "finish");
      expect(finish).toBeDefined();
      refs = finish.memories;
      messageId = finish.message_id;
    } finally {
      await app.close();
    }
  }
  expect(prompts[0]).toContain("SQLite private-value-sentinel");
  expect(prompts[0]).not.toContain("PostgreSQL");
  expect(refs).toEqual([
    {
      belief_id: f.b,
      belief_version_id: null,
      subject: "app",
      attribute: "database",
      value: "SQLite private-value-sentinel",
      provenance: {
        kind: "observation_replay",
        anchor_version_id: f.v,
        observation_id: f.next,
        evidence_id: f.e2,
      },
    },
  ]);
  const [stored] = await t.sql`select memories from messages where id=${messageId!}`;
  expect(stored?.memories).toEqual([
    {
      kind: "observation_replay",
      belief_id: f.b,
      anchor_version_id: f.v,
      observation_id: f.next,
      evidence_id: f.e2,
    },
  ]);
  expect(await business(f.p)).toBe(before);
});
it.each(["budget", "retract"])(
  "%s suppresses old anchors in prompt and citations",
  async (mode) => {
    const f = await fixture();
    if (mode === "retract")
      await t.sql`update observations set assertion_intent='RETRACT',source_type='USER_EXPLICIT' where id=${f.next}`;
    prompts.length = 0;
    const r = await respondToMessage(t.db, TEST_MASTER_KEY, f.p, f.c, "needle", {
      factory,
      retrieveFn: replay(mode === "budget"),
      durableExtraction: true,
      onJob: () => {},
    });
    expect(r).toMatchObject({ kind: "answered", abstained: true, memories: [] });
    expect(prompts[0]).not.toMatch(/PostgreSQL|SQLite/);
  },
);
it("flag-off preserves anchor context and UUID-only citations", async () => {
  const f = await fixture();
  prompts.length = 0;
  const r = await respondToMessage(t.db, TEST_MASTER_KEY, f.p, f.c, "needle", {
    factory,
    retrieveFn: replay(false, false),
    durableExtraction: true,
    onJob: () => {},
  });
  expect(prompts[0]).toContain("PostgreSQL");
  expect(prompts[0]).not.toContain("SQLite");
  expect(r).toMatchObject({ kind: "answered", memories: [{ belief_version_id: f.v }] });
});
it("invalid replay context degrades to empty memory, never to old anchors", async () => {
  const f = await fixture();
  prompts.length = 0;
  const invalid: typeof retrieve = async (...args) => {
    const r = await replay()(...args);
    r.readTimeContext!.text = "private-invalid-context";
    return r;
  };
  const r = await respondToMessage(t.db, TEST_MASTER_KEY, f.p, f.c, "needle", {
    factory,
    retrieveFn: invalid,
    durableExtraction: true,
    onJob: () => {},
  });
  expect(r).toMatchObject({ kind: "answered", abstained: true, memories: [] });
  expect(prompts[0]).not.toMatch(/PostgreSQL|SQLite|private-invalid/);
});
