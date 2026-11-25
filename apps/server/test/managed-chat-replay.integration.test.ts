import { resolveStartupRetrievalBindings } from "../src/retrieval/startup-binding.js";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import { createFeatureFlagSnapshot, DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { createProvider } from "../src/providers/repository.js";
import { buildApp } from "../src/app.js";
import { retrieve } from "../src/retrieval/search.js";
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

it("an authorized PUT enables both startup replay paths and can turn them off again", async () => {
  const f = await fixture();
  const saved = flags(false);
  await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb,revision=0`;
  const token = "offline-replay-management-token-0000000";
  const headers = { authorization: `Bearer ${token}` };
  const app = buildApp({
    authToken: token,
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    modelDailyCallLimit: 100,
    providerFactory: factory,
    ...resolveStartupRetrievalBindings(
      JSON.stringify({
        fusion: { mode: "rrf", threshold: 0.001 },
        rerankerProvider: {},
        chatReadTimeResolution: true,
        recallReadTimeResolution: true,
      }),
      { databaseConfigured: true, masterKey: TEST_MASTER_KEY },
    ),
  });
  vi.stubEnv("MNEMIC_READ_REINFORCE", undefined);
  prompts.length = 0;
  const put = (revision: number, enabled: boolean) =>
    app.inject({
      method: "PUT",
      url: "/v1/config/flags",
      headers,
      payload: {
        expected_revision: revision,
        flags: { ...saved.flags, read_time_resolution: enabled },
      },
    });
  const recall = () =>
    app.inject({
      method: "POST",
      url: `/projects/${f.p}/recall`,
      headers,
      payload: { query: "needle" },
    });
  try {
    const enabled = await put(0, true);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      kind: "updated",
      snapshot: { revision: 1, flags: { read_time_resolution: true } },
    });
    expect(prompts).toHaveLength(0);
    const audit =
      await t.sql`select meta from audit_log where action='flags.update' and target='server'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta).toMatchObject({
      before: { read_time_resolution: false },
      after: { read_time_resolution: true },
    });
    const recalled = await recall();
    expect(recalled.statusCode).toBe(200);
    expect(recalled.json()).toMatchObject({
      read_time_context: {
        memories: [{ provenance: { observation_id: f.next, evidence_id: f.e2 } }],
      },
      trace: { flags_snapshot: { revision: 1, flags: { read_time_resolution: true } } },
    });
    const chat = await app.inject({
      method: "POST",
      url: `/projects/${f.p}/conversations/${f.c}/messages`,
      headers,
      payload: { text: "needle" },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().memories[0]).toMatchObject({
      belief_version_id: null,
      provenance: { observation_id: f.next, evidence_id: f.e2 },
    });
    expect((await put(0, false)).statusCode).toBe(409);
    expect((await put(1, false)).statusCode).toBe(200);
    const legacy = await recall();
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).not.toHaveProperty("read_time_context");
    expect(legacy.json().candidates[0].value).toBe("needle PostgreSQL");
  } finally {
    vi.unstubAllEnvs();
    await app.close();
  }
});

it.each(["json", "sse"] as const)(
  "trusted chat %s applies the configured budget to the rendered memory and references",
  async (transport) => {
    const replay = transport === "sse";
    const first = await fixture();
    const second = await fixture(first.p, "secondary");
    await t.sql`update beliefs set salience='0.800' where id=${first.b}`;
    await t.sql`update observations set value='"secondary replay value"' where id=${second.next}`;
    const saved = flags(replay);
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb`;

    const expectedValue = replay ? "SQLite private-value-sentinel" : "needle PostgreSQL";
    const expectedBlock = `[1] app / database = "${expectedValue}"`;
    // Deterministic offline fixture: the counter must receive the exact numbered block.
    const countTokens = vi.fn((text: string) => text.length);
    const memoryBudget = { maxTokens: expectedBlock.length, countTokens };
    const app = buildApp({
      auth: false,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      modelDailyCallLimit: 100,
      providerFactory: factory,
      chatRetrievalBinding: {
        fusion: { mode: "rrf", threshold: 0.001 },
        rerankerProvider: {},
        ...(replay ? { readTimeResolution: true } : {}),
        memoryBudget,
      },
    });
    memoryBudget.maxTokens = 0;
    const replacementCounter = vi.fn((_text: string) => 0);
    memoryBudget.countTokens = replacementCounter;

    prompts.length = 0;
    try {
      const response = await app.inject({
        method: "POST",
        url: `/projects/${first.p}/conversations/${first.c}/messages${replay ? "/stream" : ""}`,
        payload: { text: "needle" },
      });
      expect(response.statusCode).toBe(200);
      const reply = replay
        ? response.body
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => JSON.parse(line.slice(5)))
            .find((event) => event.type === "finish")
        : response.json();
      expect(reply.abstained).toBe(false);
      expect(reply.memories).toEqual([
        expect.objectContaining({
          belief_id: first.b,
          belief_version_id: replay ? null : first.v,
          value: expectedValue,
          ...(replay
            ? {
                provenance: expect.objectContaining({
                  observation_id: first.next,
                  evidence_id: first.e2,
                }),
              }
            : {}),
        }),
      ]);
      expect(countTokens).toHaveBeenCalledWith(expectedBlock);
      expect(replacementCounter).not.toHaveBeenCalled();
      expect(prompts[0]).toContain(JSON.stringify(expectedBlock).slice(1, -1));
      expect(prompts[0]).not.toContain("secondary");
      const [answer] =
        await t.sql`select memories from messages where conversation_id=${first.c} and speaker='assistant'`;
      expect(answer?.memories).toEqual(
        replay
          ? [
              {
                kind: "observation_replay",
                belief_id: first.b,
                anchor_version_id: first.v,
                observation_id: first.next,
                evidence_id: first.e2,
              },
            ]
          : [first.v],
      );
      const [trace] =
        await t.sql`select candidates from retrieval_traces where project_id=${first.p}`;
      expect(trace?.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining(
            replay
              ? {
                  beliefVersionId: second.v,
                  readTimeResolution: expect.objectContaining({
                    status: "budget_discarded",
                    reason: "token_budget",
                  }),
                }
              : { beliefVersionId: second.v, selected: false, reason: "token_budget" },
          ),
        ]),
      );
    } finally {
      await app.close();
    }
  },
);

it.each(["json", "sse"] as const)(
  "a pinned %s budget follows the model identity actually used by Chat",
  async (transport) => {
    const f = await fixture();
    const [provider] = await t.sql`select id from provider_configs where name='offline'`;
    const saved = flags(false);
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb`;
    const budgetModel = {
      providerId: transport === "json" ? provider!.id : uuidv7(),
      modelId: "offline",
    };
    const countTokens = vi.fn((text: string) => text.length);
    const languageModel = vi.fn(factory.languageModel);
    const retrieveFn = vi.fn<typeof retrieve>(async (...args) => {
      // Simulate an operator changing the slot after this request resolves its model.
      await t.sql`update provider_configs set models='{"chat":"offline-next"}' where id=${provider!.id}`;
      return retrieve(...args);
    });
    const app = buildApp({
      auth: false,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      modelDailyCallLimit: 100,
      providerFactory: { ...factory, languageModel },
      chatDeps: { retrieveFn },
      chatRetrievalBinding: {
        fusion: { mode: "rrf", threshold: 0.001 },
        rerankerProvider: {},
        memoryBudget: { maxTokens: 100, countTokens },
        memoryBudgetModel: budgetModel,
      },
    });
    const send = () =>
      app.inject({
        method: "POST",
        url: `/projects/${f.p}/conversations/${f.c}/messages${transport === "sse" ? "/stream" : ""}`,
        payload: { text: "needle" },
      });
    const usedChatModels = () =>
      t.sql`select model_id from model_usage where project_id=${f.p} and slot='chat' order by started_at,id`;
    try {
      if (transport === "json") {
        const admitted = await send();
        expect(admitted.statusCode).toBe(200);
        expect(admitted.json().memories[0]).toMatchObject({ belief_version_id: f.v });
        expect(countTokens).toHaveBeenCalledWith('[1] app / database = "needle PostgreSQL"');
        expect(await usedChatModels()).toEqual([{ model_id: "offline" }]);
        countTokens.mockClear();
      }
      const skipped = await send();
      expect(skipped.statusCode).toBe(200);
      const reply =
        transport === "sse"
          ? skipped.body
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => JSON.parse(line.slice(5)))
              .find((item) => item.type === "finish")
          : skipped.json();
      expect(reply).toMatchObject({ memories: [], abstained: true });
      expect(retrieveFn).toHaveBeenCalledTimes(transport === "json" ? 1 : 0);
      expect(countTokens).not.toHaveBeenCalled();
      expect(await usedChatModels()).toEqual(
        transport === "json"
          ? [{ model_id: "offline" }, { model_id: "offline-next" }]
          : [{ model_id: "offline" }],
      );
      expect(languageModel).toHaveBeenCalledTimes(transport === "json" ? 2 : 1);
      const traces = await t.sql`select id from retrieval_traces where project_id=${f.p}`;
      expect(traces).toHaveLength(transport === "json" ? 1 : 0);
    } finally {
      await app.close();
      await t.sql`update provider_configs set models='{"chat":"offline"}' where id=${provider!.id}`;
    }
  },
);
