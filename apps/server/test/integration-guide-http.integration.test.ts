import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { MockEmbeddingModelV2, MockLanguageModelV2 } from "ai/test";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { registerProviderRoutes } from "../src/providers/routes.js";
import { registerRecallRoutes } from "../src/retrieval/routes.js";
import { registerChatRoutes } from "../src/chat/routes.js";
import { claimTasks } from "../src/tasks/repository.js";
import { createMemoryTaskHandlers } from "../src/tasks/memory-handlers.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import type {
  ChatConversation,
  ChatReply,
  BeliefListItem,
  BeliefDetail,
  RecallResult,
  CorrectResult,
} from "@mnemic/shared";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { jsonSchemaBounds } from "./fixtures/oas30-bounds.js";
const guide = readFileSync(new URL("../../../docs/integration-guide.md", import.meta.url), "utf8");
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;
function example(name: string): Record<string, unknown> {
  const block = guide.match(
    new RegExp(
      `<!-- example:${name} -->\\s*\u0060\u0060\u0060json\\s*([\\s\\S]*?)\u0060\u0060\u0060`,
    ),
  );
  expect(block, `missing executable guide example ${name}`).toBeTruthy();
  return JSON.parse(block![1]!);
}
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(
  {
    components: {
      schemas: Object.fromEntries(
        Object.entries(doc.components!.schemas!).map(([k, v]) => [k, jsonSchemaBounds(v)]),
      ),
    },
  },
  "guide",
);
function validate(schema: unknown, value: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"guide#/components/')),
  );
  expect(v(value), JSON.stringify(v.errors)).toBe(true);
}
const project = uuidv7(),
  token = "integration-guide-offline-token-000000";
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  base: string,
  savedProviders: unknown[] = [],
  savedFlags: unknown[] = [];
const prompts: { model: string; prompt: string }[] = [];
const factory = {
  languageModel: (_cfg: unknown, model: string) =>
    new MockLanguageModelV2({
      doGenerate: async (options) => {
        prompts.push({ model, prompt: JSON.stringify(options.prompt) });
        return {
          content: [
            {
              type: "text",
              text:
                model === "your-extraction-model"
                  ? JSON.stringify([
                      {
                        type: "decision",
                        subject: "integration-demo",
                        attribute: "database",
                        value: "PostgreSQL",
                        valid_time: "2026-11-05",
                        time_precision: "DAY",
                        time_confidence: 1,
                        assertion_intent: "ASSERT",
                        source_type: "USER_EXPLICIT",
                        importance: 0.95,
                        confidence: 0.95,
                        entities: ["integration-demo", "PostgreSQL"],
                        is_profile: false,
                      },
                    ])
                  : "OFFLINE ANSWER",
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          warnings: [],
        };
      },
    }),
  embeddingModel: () =>
    new MockEmbeddingModelV2({
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
        usage: { tokens: 3 },
      }),
    }),
};
async function request<T = unknown>(
  template: string,
  method: "get" | "post",
  status: number,
  options: {
    body?: unknown;
    query?: string;
    conversation?: string;
    belief?: string;
    auth?: boolean;
  } = {},
) {
  const url =
    base +
    template
      .replace("{projectId}", project)
      .replace("{id}", options.conversation ?? options.belief ?? "") +
    (options.query ?? "");
  const op = doc.paths[template]![method]!;
  if (options.body !== undefined) {
    const rb = op.requestBody as { content: Record<string, { schema: unknown }> };
    validate(rb.content["application/json"]!.schema, options.body);
  }
  const r = await fetch(url, {
    method: method.toUpperCase(),
    headers: {
      ...(options.auth === false ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data: unknown = await r.json();
  expect(r.status, JSON.stringify(data)).toBe(status);
  const response = op.responses[String(status)] as { content: Record<string, { schema: unknown }> };
  validate(Object.values(response.content)[0]!.schema, data);
  return data as T;
}
beforeAll(async () => {
  t = await setupTestDb();
  savedProviders = (await t.sql`select to_jsonb(p) as row from provider_configs p`).map(
    (r) => r.row,
  );
  savedFlags = (await t.sql`select to_jsonb(f) as row from feature_flags f`).map((r) => r.row);
  await t.sql`delete from provider_configs`;
  await t.sql`update feature_flags set flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb`;
  await t.sql`insert into projects(id,name) values(${project},'integration-demo')`;
  app = buildApp({
    db: t.db,
    authToken: token,
    providerFactory: factory,
    logStream: { write: () => {} },
  });
  // Register the actual key-dependent modules in durable mode without starting a scheduler.
  registerProviderRoutes(app, t.db, TEST_MASTER_KEY);
  registerRecallRoutes(app, t.db, TEST_MASTER_KEY, factory);
  registerChatRoutes(app, t.db, TEST_MASTER_KEY, { durableExtraction: true, factory });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  await app?.close();
  if (t)
    try {
      await t.sql`delete from memory_tasks where project_id=${project}`;
      await t.sql`delete from memory_embeddings where belief_version_id in (select v.id from belief_versions v join beliefs b on b.id=v.belief_id where b.project_id=${project})`;
      await t.sql`delete from retrieval_traces where project_id=${project}`;
      await t.sql`delete from resolution_traces where project_id=${project}`;
      await t.sql`delete from model_usage where project_id=${project}`;
      await t.sql`delete from pending_candidates where project_id=${project}`;
      await t.sql`update beliefs set current_version_id=null where project_id=${project}`;
      await t.sql`delete from belief_versions where belief_id in (select id from beliefs where project_id=${project})`;
      await t.sql`delete from beliefs where project_id=${project}`;
      await t.sql`delete from observations where project_id=${project}`;
      await t.sql`delete from audit_log where meta->>'project_id'=${project} or target in (select id::text from provider_configs)`;
      await t.sql`delete from messages where conversation_id in (select id from conversations where project_id=${project})`;
      await t.sql`delete from conversations where project_id=${project}`;
      await t.sql`delete from projects where id=${project}`;
    } finally {
      try {
        await t.sql.begin(async (tx) => {
          await tx`delete from provider_configs`;
          if (savedProviders.length)
            await tx`insert into provider_configs select * from jsonb_populate_recordset(null::provider_configs,${JSON.stringify(savedProviders)}::jsonb)`;
          await tx`delete from feature_flags`;
          if (savedFlags.length)
            await tx`insert into feature_flags select * from jsonb_populate_recordset(null::feature_flags,${JSON.stringify(savedFlags)}::jsonb)`;
        });
      } finally {
        await t.close();
      }
    }
});
it("guide examples complete three slots, durable Evidence, retrieval, correction/history, deletion and restore over real HTTP", async () => {
  // Configuration examples are sent unchanged; only the documented project UUID placeholder is replaced.
  const text = example("provider-text"),
    embedding = example("provider-embedding");
  for (const body of [text, embedding]) {
    const result = await request<Record<string, unknown>>("/providers", "post", 201, { body });
    expect(JSON.stringify(result)).not.toContain(body.api_key);
    const [stored] =
      await t.sql`select api_key_encrypted from provider_configs where id=${result.id as string}`;
    expect(stored!.api_key_encrypted).toMatch(/^v1:/);
    expect(stored!.api_key_encrypted).not.toContain(body.api_key);
  }
  const config = await request<{ slots: Record<string, { model: string }> }>(
    "/v1/config",
    "get",
    200,
  );
  expect(config.slots.chat!.model).toBe("your-chat-model");
  expect(config.slots.extraction!.model).toBe("your-extraction-model");
  expect(config.slots.embedding!.model).toBe("your-embedding-model");
  const created = await request<ChatConversation>("/v1/conversations", "post", 200, {
    body: { ...example("create-conversation"), project_id: project },
  });
  const answer = await request<ChatReply>(
    "/projects/{projectId}/conversations/{id}/messages",
    "post",
    200,
    { conversation: created.id, body: example("send-message") },
  );
  expect(answer.memories).toEqual([]);
  const [admitted] =
    await t.sql`select id,extracted_at from messages where conversation_id=${created.id} and speaker='user'`;
  expect(admitted!.extracted_at).toBeNull();
  const [queued] = await t.sql`select status from memory_tasks where project_id=${project}`;
  expect(queued!.status).toBe("queued");
  const handlers = createMemoryTaskHandlers(t.db, TEST_MASTER_KEY, { factory });
  for (const type of ["EXTRACT", "REEMBED"] as const) {
    const tasks = await claimTasks(t.db, {
      projectId: project,
      types: [type],
      limit: 10,
      leaseMs: 30000,
    });
    expect(tasks).toHaveLength(1);
    await handlers[type](tasks[0]!, {
      signal: new AbortController().signal,
      checkpoint: () => {},
    });
  }
  expect(
    (await t.sql`select status from memory_tasks where project_id=${project}`).map((r) => r.status),
  ).toEqual(["done", "done"]);
  const list = await request<BeliefListItem[]>("/projects/{projectId}/beliefs", "get", 200);
  expect(list).toHaveLength(1);
  const belief = list[0]!.id;
  expect(list[0]!.current_value).toBe("PostgreSQL");
  const detail = await request<BeliefDetail>("/projects/{projectId}/beliefs/{id}", "get", 200, {
    belief,
  });
  expect(detail.versions[0]!.source).toMatchObject({
    message_id: admitted!.id,
    conversation_id: created.id,
  });
  const recall = await request<RecallResult>("/projects/{projectId}/recall", "post", 200, {
    body: example("recall-memory"),
  });
  expect(recall.abstained).toBe(false);
  expect(recall.candidates[0]!.beliefId).toBe(belief);
  const corrected = await request<CorrectResult>(
    "/projects/{projectId}/beliefs/{id}/correct",
    "post",
    200,
    { belief, body: example("correct-memory") },
  );
  expect(corrected.beliefId).toBe(belief);
  const changed = await request<BeliefDetail>("/projects/{projectId}/beliefs/{id}", "get", 200, {
    belief,
  });
  expect(changed.current_value).toBe("SQLite");
  expect(changed.versions).toHaveLength(2);
  expect(changed.versions.map((v) => v.value)).toEqual(["PostgreSQL", "SQLite"]);
  expect(changed.versions[0]!.recorded_to).not.toBeNull();
  expect(
    await request<unknown[]>("/projects/{projectId}/beliefs/{id}/resolutions", "get", 200, {
      belief,
    }),
  ).toHaveLength(1);
  await request("/projects/{projectId}/beliefs/{id}/delete", "post", 200, { belief });
  expect(await request("/projects/{projectId}/beliefs", "get", 200)).toEqual([]);
  expect(
    (
      await request<RecallResult>("/projects/{projectId}/recall", "post", 200, {
        body: example("recall-memory"),
      })
    ).abstained,
  ).toBe(true);
  await request("/projects/{projectId}/beliefs/{id}/restore", "post", 200, { belief });
  expect(
    (await request<BeliefListItem[]>("/projects/{projectId}/beliefs", "get", 200))[0]!.status,
  ).toBe("active");
  const committed = await request<{ extraction_triggered: boolean }>(
    "/v1/conversations/{id}/commit",
    "post",
    200,
    { conversation: created.id },
  );
  expect(committed.extraction_triggered).toBe(false);
  expect(prompts.some((p) => p.model === "your-extraction-model")).toBe(true);
});
it("guide health/docs are public but business requests need the operator token", async () => {
  const health = await fetch(base + "/health");
  expect(await health.json()).toEqual({ status: "ok" });
  const reference = await fetch(base + "/docs");
  expect(reference.status).toBe(200);
  const artifact = await fetch(base + "/docs/openapi.json");
  expect(await artifact.json()).toEqual(doc);
  await request("/v1/config", "get", 401, { auth: false });
});

it("every documented curl method/path resolves to a checked HTTP operation, including proxy-relative base URLs", () => {
  const scripts = [...guide.matchAll(/```sh\s*([\s\S]*?)```/g)]
    .map((m) => m[1]!.replace(/\\\n\s*/g, " "))
    .join("\n");
  const curls = [...scripts.matchAll(/^curl[^\n]+/gm)].map((m) => m[0]);
  expect(curls.length).toBeGreaterThan(15);
  for (const command of curls) {
    const method = command.match(/--request (\w+)/)?.[1]?.toLowerCase() ?? "get";
    const raw = command.match(/"\$mnemic_url([^" ]+)"/)?.[1];
    expect(raw, command).toBeTruthy();
    const path = raw!
      .split("?")[0]!
      .replaceAll("$mnemic_project_id", "{projectId}")
      .replaceAll("$mnemic_conversation_id", "{id}")
      .replaceAll("$mnemic_belief_id", "{id}");
    expect(doc.paths[path], command).toHaveProperty(method);
  }
});
