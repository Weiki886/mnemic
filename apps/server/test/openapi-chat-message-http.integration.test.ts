import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import type { ChatReply, ProblemDetails } from "@mnemic/shared";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildApp } from "../src/app.js";
import { registerChatRoutes } from "../src/chat/routes.js";
import { ModelQuotaError } from "../src/quota/repository.js";
import { createProvider } from "../src/providers/repository.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { requestOversizeHeaders } from "./fixtures/oversize-request.js";
import { jsonSchemaBounds } from "./fixtures/oas30-bounds.js";
const path = "/projects/{projectId}/conversations/{id}/messages";
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "date-time": /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/,
  },
});
ajv.addSchema(
  {
    components: {
      schemas: Object.fromEntries(
        Object.entries(doc.components!.schemas!).map(([key, value]) => [
          key,
          jsonSchemaBounds(value),
        ]),
      ),
    },
  },
  "json-chat",
);
const p = uuidv7(),
  foreign = uuidv7(),
  bid = uuidv7(),
  vid = uuidv7();
const token = "chat-contract-offline-token-00000",
  secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
const headers = { authorization: `Bearer ${token}` };
const logs: string[] = [],
  prompts: string[] = [];
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  base: string,
  savedProviders: unknown[] = [];
let cite = false,
  value: unknown = null,
  retrievalFails = false,
  failChat = false;
let archiveDuringGeneration: string | undefined;
const model = new MockLanguageModelV2({
  doGenerate: async (opts) => {
    prompts.push(JSON.stringify(opts.prompt));
    if (failChat) throw Error(secret);
    if (archiveDuringGeneration)
      await t.sql`update conversations set ended_at=now() where id=${archiveDuringGeneration}`;
    return {
      content: [{ type: "text", text: "offline answer" }],
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
      warnings: [],
    };
  },
});
const languageModel = vi.fn(() => model);
const embeddingModel = vi.fn(() => {
  throw Error("retrieval is offline; embedding must not be invoked");
});
const factory = { languageModel, embeddingModel };
const retrieveFn = vi.fn(async () => {
  if (retrievalFails) throw Error(secret);
  return {
    traceId: uuidv7(),
    abstained: !cite,
    candidates: cite
      ? [
          {
            beliefId: bid,
            beliefVersionId: vid,
            subject: "chat-project",
            attribute: "database",
            value,
            vectorScore: 1,
            keywordScore: null,
            fusedScore: 1,
            selected: true,
            reason: "top_k" as const,
          },
        ]
      : [],
  };
});
function validate(schema: unknown, body: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"json-chat#/components/')),
  );
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
function example() {
  const rb = doc.paths[path]!.post!.requestBody as {
    content: Record<string, { schema: unknown; example: Record<string, unknown> }>;
  };
  const media = rb.content["application/json"]!;
  validate(media.schema, media.example);
  return structuredClone(media.example);
}
async function conversation(meta?: object, ended = false) {
  const id = uuidv7();
  await t.sql`insert into conversations(id,project_id,meta,ended_at) values(${id},${p},${JSON.stringify(meta ?? {})}::jsonb,${ended ? new Date().toISOString() : null})`;
  return id;
}
async function effects(id: string) {
  const rows =
    await t.sql`select id,speaker,raw_text,attachment,memories,extracted_at,generation_status from messages where conversation_id=${id} order by msg_time,id`;
  const tasks =
    await t.sql`select status,payload,idempotency_key from memory_tasks where project_id=${p} and payload->>'evidence_id' in (select id::text from messages where conversation_id=${id})`;
  return { rows, tasks };
}
async function send<T = ChatReply>(
  id: string,
  status: number,
  opts: {
    project?: string;
    body?: unknown;
    raw?: string;
    media?: string;
    auth?: boolean;
    query?: string;
    oversize?: boolean;
    origin?: string;
  } = {},
  server = base,
) {
  const url =
    server +
    path.replace("{projectId}", opts.project ?? p).replace("{id}", id) +
    (opts.query ?? "");
  const h = {
    ...(opts.auth === false ? {} : headers),
    ...(opts.body !== undefined || opts.raw !== undefined || opts.oversize
      ? { "content-type": opts.media ?? "application/json" }
      : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
  const r = opts.oversize
    ? await requestOversizeHeaders(url, h, 1048577)
    : await fetch(url, {
        method: "POST",
        headers: h,
        ...(opts.raw !== undefined
          ? { body: opts.raw }
          : opts.body !== undefined
            ? { body: JSON.stringify(opts.body) }
            : {}),
      });
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("content-type")).toContain(
    status === 200 ? "application/json" : "application/problem+json",
  );
  expect(r.headers.get("x-request-id")).toBeTruthy();
  const response = doc.paths[path]!.post!.responses[String(status)] as
    { content: Record<string, { schema: unknown }> } | undefined;
  expect(response, `undocumented status ${status}`).toBeTruthy();
  validate(Object.values(response!.content)[0]!.schema, body);
  return { body: body as T, response: r };
}
beforeAll(async () => {
  t = await setupTestDb();
  savedProviders = (await t.sql`select to_jsonb(p) as row from provider_configs p`).map(
    (r) => r.row,
  );
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "json-contract-offline",
    protocol: "openai-compatible",
    baseUrl: "https://offline.invalid/v1",
    apiKey: "offline-fake-key",
    models: { chat: "offline-chat" },
  });
  await t.sql`insert into projects(id,name) values(${p},'json-contract'),(${foreign},'foreign-contract')`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute) values(${bid},${p},'chat-project','database')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${vid},${bid},'null'::jsonb,now(),now())`;
  await t.sql`update beliefs set current_version_id=${vid} where id=${bid}`;
  app = buildApp({
    db: t.db,
    authToken: token,
    corsOrigin: "https://web.example.invalid",
    logStream: {
      write: (s) => {
        logs.push(s);
      },
    },
  });
  // Real production module, durable outbox enabled, deliberately no worker/model extraction.
  registerChatRoutes(app, t.db, TEST_MASTER_KEY, { durableExtraction: true, factory, retrieveFn });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
beforeEach(() => {
  cite = false;
  value = null;
  retrievalFails = false;
  failChat = false;
  archiveDuringGeneration = undefined;
});
afterAll(async () => {
  await app?.close();
  if (t)
    try {
      await t.sql`delete from memory_tasks where project_id in (${p},${foreign})`;
      await t.sql`delete from model_usage where project_id in (${p},${foreign})`;
      await t.sql`delete from audit_log where target in (select id::text from messages where conversation_id in (select id from conversations where project_id in (${p},${foreign})))`;
      await t.sql`delete from messages where conversation_id in (select id from conversations where project_id in (${p},${foreign}))`;
      await t.sql`delete from conversations where project_id in (${p},${foreign})`;
      await t.sql`update beliefs set current_version_id=null where id=${bid}`;
      await t.sql`delete from belief_versions where id=${vid}`;
      await t.sql`delete from beliefs where id=${bid}`;
      await t.sql`delete from projects where id in (${p},${foreign})`;
      await t.sql.begin(async (tx) => {
        await tx`delete from provider_configs`;
        if (savedProviders.length)
          await tx`insert into provider_configs select * from jsonb_populate_recordset(null::provider_configs,${JSON.stringify(savedProviders)}::jsonb)`;
      });
    } finally {
      await t.close();
    }
  expect(embeddingModel).not.toHaveBeenCalled();
  expect(logs.join("")).not.toContain(secret);
});
it("published JSON example saves separate file Evidence, real usage and queued extraction without running a worker", async () => {
  const id = await conversation(),
    payload = example(),
    before = prompts.length;
  const { body } = await send(id.toUpperCase(), 200, {
    project: p.toUpperCase(),
    body: payload,
    query: "?ignored=true",
    media: "application/json; charset=utf-8",
    origin: "https://web.example.invalid",
  });
  expect(body).toMatchObject({
    answer: "offline answer",
    abstained: true,
    history_included: false,
    memories: [],
  });
  expect(prompts).toHaveLength(before + 1);
  expect(prompts.at(-1)).toContain("The offline example uses PostgreSQL.");
  const { rows, tasks } = await effects(id);
  expect(rows).toHaveLength(3);
  const user = rows.find((r) => r.speaker === "user")!,
    file = rows.find((r) => r.speaker === "tool")!,
    assistant = rows.find((r) => r.speaker === "assistant")!;
  expect(user.raw_text).toBe(payload.text);
  expect(file.attachment).toMatchObject({
    source_type: "PROJECT_FILE",
    parent_message_id: user.id,
    path: "README.md",
    truncated: false,
  });
  expect(assistant).toMatchObject({
    id: body.message_id,
    raw_text: "offline answer",
    memories: null,
    generation_status: null,
  });
  expect(rows.every((r) => r.extracted_at === null)).toBe(true);
  expect(tasks).toHaveLength(2);
  expect(tasks.every((task) => task.status === "queued")).toBe(true);
  expect(new Set(tasks.map((task) => task.payload.evidence_id))).toEqual(
    new Set([user.id, file.id]),
  );
  const [usage] =
    await t.sql`select purpose,status,conversation_id,prompt_tokens,completion_tokens,total_tokens from model_usage where conversation_id=${id}`;
  expect(usage).toMatchObject({
    purpose: "chat",
    status: "success",
    conversation_id: id,
    prompt_tokens: "7",
    completion_tokens: "2",
    total_tokens: "9",
  });
  expect(await t.sql`select id from observations where project_id=${p}`).toHaveLength(0);
});
it("strict output preserves required JSON citation null and stores version IDs, then sends prior history", async () => {
  cite = true;
  value = { dialect: [null, true, 7] };
  const id = await conversation();
  const first = (await send(id, 200, { body: { text: "first turn" } })).body;
  expect(first.memories).toEqual([
    {
      belief_id: bid,
      belief_version_id: vid,
      subject: "chat-project",
      attribute: "database",
      value,
    },
  ]);
  const [saved] = await t.sql`select memories from messages where id=${first.message_id}`;
  expect(saved!.memories).toEqual([vid]);
  value = null;
  const second = (await send(id, 200, { body: { text: "second turn" } })).body;
  expect(second.history_included).toBe(true);
  expect(second.memories[0]!.value).toBeNull();
  expect(prompts.at(-1)).toContain("first turn");
  expect(prompts.at(-1)).toContain("offline answer");
  const output = ajv.compile({ $ref: "json-chat#/components/schemas/JsonChatReply" });
  const { value: _v, ...missing } = second.memories[0]!;
  expect(output({ ...second, memories: [missing] })).toBe(false);
});
it("file content is redacted before storage/prompt and persisted redaction audit shares its Evidence", async () => {
  const id = await conversation();
  await send(id, 200, {
    body: {
      text: "inspect file",
      attachments: [{ kind: "file", path: "config.txt", content: secret, truncated: true }],
    },
  });
  const { rows } = await effects(id),
    file = rows.find((r) => r.speaker === "tool")!;
  expect(file.raw_text).toContain("[REDACTED]");
  expect(JSON.stringify(rows)).not.toContain(secret);
  expect(prompts.at(-1)).not.toContain(secret);
  const [audit] =
    await t.sql`select actor,action,decision,meta from audit_log where target=${file.id}`;
  expect(audit).toMatchObject({
    actor: "gate",
    action: "redact",
    decision: "redacted",
    meta: { count: 1 },
  });
  expect(JSON.stringify(audit)).not.toContain(secret);
});
it("user text is not trimmed or advertised as sanitized, and identical sends are not idempotent", async () => {
  const id = await conversation(),
    payload = { text: `  ${secret}  ` };
  const a = (await send(id, 200, { body: payload })).body;
  const b = (await send(id, 200, { body: payload })).body;
  expect(a.message_id).not.toBe(b.message_id);
  expect(prompts.at(-1)).toContain(secret);
  const { rows, tasks } = await effects(id);
  expect(rows.filter((r) => r.speaker === "user").map((r) => r.raw_text)).toEqual([
    payload.text,
    payload.text,
  ]);
  expect(tasks).toHaveLength(2);
});
it("retrieval failure degrades to a no-memory answer and still invokes chat", async () => {
  retrievalFails = true;
  const id = await conversation(),
    before = prompts.length;
  expect((await send(id, 200, { body: { text: "fallback" } })).body).toMatchObject({
    answer: "offline answer",
    abstained: true,
    memories: [],
  });
  expect(prompts).toHaveLength(before + 1);
});
const file = (content = "x", path = "README.md") => ({
  kind: "file",
  path,
  content,
  truncated: false,
});
it.each([
  ["missing body", undefined],
  ["empty object", {}],
  ["empty text", { text: "" }],
  ["long text", { text: "x".repeat(8001) }],
  ["unknown body field", { text: "x", flags: {} }],
  [
    "unknown attachment field",
    { text: "x", attachments: [{ ...file(), source_type: "USER_CORRECTION" }] },
  ],
  ["sensitive path", { text: "x", attachments: [file("x", ".env")] }],
  ["path escape", { text: "x", attachments: [file("x", "../x")] }],
  ["duplicate path", { text: "x", attachments: [file(), file()] }],
  ["binary control", { text: "x", attachments: [file("\u0000")] }],
  ["UTF8 byte overflow", { text: "x", attachments: [file("中".repeat(5500))] }],
  [
    "nine files",
    { text: "x", attachments: Array.from({ length: 9 }, (_, i) => file("x", `f${i}`)) },
  ],
  [
    "aggregate overflow",
    {
      text: "x",
      attachments: Array.from({ length: 5 }, (_, i) => file("x".repeat(16384), `f${i}`)),
    },
  ],
])("%s is rejected before Evidence, outbox or model calls", async (_name, body) => {
  const id = await conversation(),
    before = prompts.length;
  const result = await send<ProblemDetails>(id, 400, { body });
  expect(result.body.code).toBe("VALIDATION_FAILED");
  expect(result.body.errors?.length).toBeGreaterThan(0);
  expect(await effects(id)).toEqual({ rows: [], tasks: [] });
  expect(prompts).toHaveLength(before);
});
it("bad UUID and foreign/missing conversations reject before model or data writes", async () => {
  const id = await conversation(),
    before = prompts.length;
  await send("not-uuid", 400, { body: { text: "x" } });
  await send(id, 400, { project: "not-uuid", body: { text: "x" } });
  const foreignResult = await send<ProblemDetails>(id, 404, {
    project: foreign,
    body: { text: "x" },
  });
  const missing = await send<ProblemDetails>(uuidv7(), 404, { body: { text: "x" } });
  expect(foreignResult.body.code).toBe(missing.body.code);
  expect(prompts).toHaveLength(before);
  expect(await effects(id)).toEqual({ rows: [], tasks: [] });
});
it("archived and corrupt inherited/file history reject without partial admission", async () => {
  const ended = await conversation(undefined, true);
  const broken = await conversation({
    resume: { version: 1, from: uuidv7(), message_ids: [uuidv7()] },
  });
  const fileBroken = await conversation();
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time,attachment) values(${uuidv7()},${fileBroken},'tool','orphan',now(),${JSON.stringify({ version: 1, kind: "file", path: "README.md", truncated: false, parent_message_id: uuidv7(), source_type: "PROJECT_FILE" })}::jsonb)`;
  const before = prompts.length;
  for (const id of [ended, broken, fileBroken]) await send(id, 409, { body: { text: "x" } });
  expect((await effects(ended)).rows).toHaveLength(0);
  expect((await effects(broken)).rows).toHaveLength(0);
  expect((await effects(fileBroken)).rows).toHaveLength(1);
  expect((await effects(fileBroken)).tasks).toHaveLength(0);
  expect(prompts).toHaveLength(before);
});
it("provider failure returns fixed500 but leaves admitted Evidence and durable work", async () => {
  failChat = true;
  const id = await conversation();
  const { body } = await send<ProblemDetails>(id, 500, { body: { text: "model fails" } });
  expect(body.detail).toBe("服务器内部错误");
  expect(JSON.stringify(body)).not.toContain(secret);
  const { rows, tasks } = await effects(id);
  expect(rows.map((r) => r.speaker)).toEqual(["user"]);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.status).toBe("queued");
  const usages = await t.sql`select status from model_usage where conversation_id=${id}`;
  expect(usages.length).toBeGreaterThan(0);
  expect(usages.every((u) => u.status === "error")).toBe(true);
});
it("archive while model is running can return409 after successful paid-boundary invocation", async () => {
  const id = await conversation();
  archiveDuringGeneration = id;
  await send(id, 409, { body: { text: "racing archive" } });
  const { rows, tasks } = await effects(id);
  expect(rows.map((r) => r.speaker)).toEqual(["user"]);
  expect(tasks).toHaveLength(1);
  expect((await t.sql`select status from model_usage where conversation_id=${id}`)[0]!.status).toBe(
    "success",
  );
});
it.each(["exhausted", "unavailable"] as const)(
  "chat quota %s exposes its typed error after Evidence admission without provider invocation",
  async (reason) => {
    const isolated = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
    registerChatRoutes(isolated, t.db, TEST_MASTER_KEY, {
      durableExtraction: true,
      factory,
      retrieveFn,
      admitModelCall: async () => {
        throw new ModelQuotaError(reason, 60);
      },
    });
    const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
    try {
      const id = await conversation(),
        before = prompts.length;
      const { body, response } = await send<ProblemDetails>(
        id,
        reason === "exhausted" ? 429 : 503,
        { body: { text: "quota boundary" } },
        address,
      );
      expect(body.code).toBe(
        reason === "exhausted" ? "MODEL_QUOTA_EXCEEDED" : "MODEL_QUOTA_UNAVAILABLE",
      );
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await effects(id)).rows.map((r) => r.speaker)).toEqual(["user"]);
      expect((await effects(id)).tasks).toHaveLength(1);
      expect(prompts).toHaveLength(before);
      expect(await t.sql`select id from model_usage where conversation_id=${id}`).toHaveLength(0);
    } finally {
      await isolated.close();
    }
  },
);
it("malformed JSON, text/plain, unsupported media and oversize fail before admission", async () => {
  const id = await conversation(),
    before = prompts.length;
  await send(id, 400, { raw: "{broken" });
  await send(id, 400, { raw: "text", media: "text/plain" });
  await send(id, 415, { raw: "<xml/>", media: "text/xml" });
  await send(id, 413, { oversize: true });
  expect(await effects(id)).toEqual({ rows: [], tasks: [] });
  expect(prompts).toHaveLength(before);
});
it("auth and HTTP request budgets reject before JSON parsing or any DB/model access", async () => {
  let reads = 0;
  const tripwire = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error(secret);
    },
  });
  const isolated = buildApp({
    db: tripwire,
    authToken: token,
    rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } },
    logStream: { write: () => {} },
  });
  registerChatRoutes(isolated, tripwire, TEST_MASTER_KEY, { factory, retrieveFn });
  const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
  try {
    const { body } = await send<ProblemDetails>(
      uuidv7(),
      401,
      { raw: "{broken", auth: false },
      address,
    );
    expect(body.code).toBe("UNAUTHORIZED");
    const limited = await send<ProblemDetails>(uuidv7(), 429, { raw: "{broken" }, address);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(reads).toBe(0);
  } finally {
    await isolated.close();
  }
});
it.each(["database", "master key"])(
  "missing %s leaves the JSON send route unregistered",
  async (dependency) => {
    const isolated = buildApp({
      ...(dependency === "database" ? { masterKey: TEST_MASTER_KEY } : { db: t.db }),
      authToken: token,
      logStream: { write: () => {} },
    });
    const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
    try {
      await send(uuidv7(), 404, { body: { text: "unregistered" } }, address);
    } finally {
      await isolated.close();
    }
  },
);
