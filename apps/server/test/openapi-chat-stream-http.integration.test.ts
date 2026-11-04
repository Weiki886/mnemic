import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import { APICallError } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ChatStreamEvent, ChatStreamCancel } from "@mnemic/shared/chat-stream";
import type { ProblemDetails } from "@mnemic/shared";
import { buildApp } from "../src/app.js";
import { registerChatStreamRoutes } from "../src/chat/stream-routes.js";
import { ChatGenerations, type Generation } from "../src/chat/generations.js";
import { createProvider } from "../src/providers/repository.js";
import { ModelQuotaError } from "../src/quota/repository.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { jsonSchemaBounds } from "./fixtures/oas30-bounds.js";
import { requestOversizeHeaders } from "./fixtures/oversize-request.js";
const root = "/projects/{projectId}/conversations/{id}",
  streamPath = root + "/messages/stream",
  cancelPath = root + "/generations/{generationId}/cancel";
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
        Object.entries(doc.components!.schemas!).map(([k, v]) => [k, jsonSchemaBounds(v)]),
      ),
    },
  },
  "sse",
);
const p = uuidv7(),
  foreign = uuidv7(),
  bid = uuidv7(),
  vid = uuidv7();
const token = "sse-contract-offline-token-000000",
  secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
  prefix = "partial119😀\nevent: error\ndata: fake";
const auth = { authorization: `Bearer ${token}` };
type Chunk =
  Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer T>
    ? T
    : never;
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  base: string,
  savedProviders: unknown[] = [];
let source: ReadableStreamDefaultController<Chunk> | undefined,
  modelSignal: AbortSignal | undefined;
let mode: "gated" | "complete" | "error" | "throw" | "silent" = "gated",
  finishReason: "stop" | "length" | "tool-calls" = "stop",
  cite = false,
  calls = 0;
const logs: string[] = [],
  prompts: string[] = [];
const registry = new ChatGenerations();
const factory = {
  languageModel: () =>
    new MockLanguageModelV2({
      doStream: async (opts) => {
        calls++;
        prompts.push(JSON.stringify(opts.prompt));
        modelSignal = opts.abortSignal;
        if (mode === "throw")
          throw new APICallError({
            message: secret,
            url: "https://offline.invalid",
            requestBodyValues: {},
            statusCode: 401,
            isRetryable: false,
          });
        return {
          stream: new ReadableStream<Chunk>({
            start(controller) {
              source = controller;
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "text" });
              if (mode !== "silent")
                controller.enqueue({ type: "text-delta", id: "text", delta: prefix });
              if (mode === "error") {
                controller.enqueue({ type: "error", error: Error(secret) });
                controller.close();
                source = undefined;
              }
              if (mode === "complete") finish();
            },
          }),
        };
      },
    }),
  embeddingModel: vi.fn(() => {
    throw Error("offline retrieval must not construct embeddings");
  }),
};
const retrieveFn = async () => ({
  traceId: uuidv7(),
  abstained: !cite,
  candidates: cite
    ? [
        {
          beliefId: bid,
          beliefVersionId: vid,
          subject: "sse-project",
          attribute: "database",
          value: null,
          vectorScore: 1,
          keywordScore: null,
          fusedScore: 1,
          selected: true,
          reason: "top_k" as const,
        },
      ]
    : [],
});
function finish() {
  source!.enqueue({ type: "text-end", id: "text" });
  source!.enqueue({
    type: "finish",
    finishReason,
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  });
  source!.close();
  source = undefined;
}
function closeSource() {
  try {
    source?.close();
  } catch {
    /* Already closed/cancelled. */
  }
  source = undefined;
}
function validate(schema: unknown, body: unknown) {
  const valid = ajv.compile(
    JSON.parse(
      JSON.stringify(jsonSchemaBounds(schema)).replaceAll('"#/components/', '"sse#/components/'),
    ),
  );
  expect(valid(body), JSON.stringify(valid.errors)).toBe(true);
}
function media(path: string, status: number, type: string) {
  const responses = doc.paths[path]!.post!.responses;
  const response = (responses[String(status)] ?? responses.default) as {
    content: Record<string, { schema: Record<string, unknown>; example?: unknown }>;
  };
  expect(response, `undocumented status ${status}`).toBeTruthy();
  return response.content[type]!;
}
function example(path: string) {
  const rb = doc.paths[path]!.post!.requestBody as {
    content: Record<string, { schema: unknown; example: Record<string, unknown> }>;
  };
  const m = rb.content["application/json"]!;
  validate(m.schema, m.example);
  return structuredClone(m.example);
}
async function conversation(meta = {}) {
  const id = uuidv7();
  await t.sql`insert into conversations(id,project_id,meta) values(${id},${p},${JSON.stringify(meta)}::jsonb)`;
  return id;
}
async function effects(id: string) {
  const rows =
    await t.sql`select id,speaker,raw_text,attachment,generation_status,memories,extracted_at from messages where conversation_id=${id} order by msg_time,id`;
  const tasks =
    await t.sql`select payload,status from memory_tasks where project_id=${p} and payload->>'evidence_id' in (select id::text from messages where conversation_id=${id})`;
  return { rows, tasks };
}
async function saved(id: string) {
  return (
    await t.sql`select id,raw_text,generation_status,memories from messages where id=${id}`
  )[0];
}
// Aborting fetch can open a replacement idle pooled socket. This intentional
// disconnect uses one native TCP request with no agent/replacement connection.
function unpooledResponse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", agent: false, headers }, (res) => {
      const responseHeaders = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2)
        responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
      resolve(
        new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
          status: res.statusCode!,
          headers: responseHeaders,
        }),
      );
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}
interface Options {
  body?: unknown;
  raw?: string;
  media?: string;
  project?: string;
  query?: string;
  auth?: boolean;
  oversize?: boolean;
  origin?: string;
  unpooled?: boolean;
}
async function request<S extends number>(
  path: string,
  id: string,
  status: S,
  opts: Options = {},
  generation = uuidv7(),
  address = base,
) {
  const url =
    address +
    path
      .replace("{projectId}", opts.project ?? p)
      .replace("{id}", id)
      .replace("{generationId}", generation) +
    (opts.query ?? "");
  const h = {
    ...(opts.auth === false ? {} : auth),
    ...(opts.raw !== undefined || opts.body !== undefined || opts.oversize
      ? { "content-type": opts.media ?? "application/json" }
      : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
  const r = opts.oversize
    ? await requestOversizeHeaders(url, h, 1048577)
    : opts.unpooled
      ? await unpooledResponse(url, h, opts.body)
      : await fetch(url, {
          method: "POST",
          headers: h,
          ...(opts.raw !== undefined
            ? { body: opts.raw }
            : opts.body !== undefined
              ? { body: JSON.stringify(opts.body) }
              : {}),
        });
  if (path === streamPath && status === 200) {
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
    expect(r.headers.get("x-request-id")).toBeTruthy();
    return { response: r, body: undefined };
  }
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("content-type")).toContain(
    status === 200 ? "application/json" : "application/problem+json",
  );
  expect(r.headers.get("x-request-id")).toBeTruthy();
  validate(
    media(path, status, status === 200 ? "application/json" : "application/problem+json").schema,
    body,
  );
  return { response: r, body: body as S extends 200 ? ChatStreamCancel : ProblemDetails };
}
// Independent narrow parser for the exact two-line LF framing emitted by this server.
// It does not use the shared encoder/consumer as its expected result.
async function frames(response: Response, onEvent?: (event: ChatStreamEvent) => Promise<void>) {
  const reader = response.body!.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const events: ChatStreamEvent[] = [];
  let pending = "",
    terminal = false;
  try {
    const eventSchema = media(streamPath, 200, "text/event-stream").schema["x-sse-event-schema"];
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at: number;
      while ((at = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, at);
        pending = pending.slice(at + 2);
        const lines = block.split("\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^event: (start|delta|finish|error)$/);
        expect(lines[1]).toMatch(/^data: /);
        const event = JSON.parse(lines[1]!.slice(6)) as ChatStreamEvent;
        validate(eventSchema, event);
        expect(lines[0]).toBe(`event: ${event.type}`);
        expect(terminal).toBe(false);
        if (!events.length) expect(event.type).toBe("start");
        else {
          expect(event.type).not.toBe("start");
          expect(event.generation_id).toBe(events[0]!.generation_id);
        }
        terminal = event.type === "finish" || event.type === "error";
        events.push(event);
        await onEvent?.(event);
      }
      if (done) break;
    }
    expect(pending).toBe("");
    expect(terminal).toBe(true);
    return events;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
beforeAll(async () => {
  t = await setupTestDb();
  savedProviders = (await t.sql`select to_jsonb(p) as row from provider_configs p`).map(
    (r) => r.row,
  );
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "sse-contract-offline",
    protocol: "openai-compatible",
    baseUrl: "https://offline.invalid",
    apiKey: "offline-fake-key",
    models: { chat: "offline-chat" },
  });
  await t.sql`insert into projects(id,name) values(${p},'sse-contract'),(${foreign},'foreign-sse')`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute) values(${bid},${p},'sse-project','database')`;
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
  registerChatStreamRoutes(app, t.db, TEST_MASTER_KEY, registry, {
    durableExtraction: true,
    factory,
    retrieveFn,
    onJob: () => {
      throw Error("durable mode must not schedule process-local extraction");
    },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
beforeEach(() => {
  mode = "gated";
  finishReason = "stop";
  cite = false;
  modelSignal = undefined;
});
afterEach(async () => {
  closeSource();
  // Abort forwarding deliberately does not wait for telemetry storage. Drain the
  // observable usage rows before deleting their conversation FK in teardown.
  await vi.waitFor(async () => {
    const [row] = await t.sql`select count(*)::int as n from model_usage where project_id=${p}`;
    expect(row!.n).toBe(calls);
  });
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
    } finally {
      try {
        await t.sql.begin(async (tx) => {
          await tx`delete from provider_configs`;
          if (savedProviders.length)
            await tx`insert into provider_configs select * from jsonb_populate_recordset(null::provider_configs,${JSON.stringify(savedProviders)}::jsonb)`;
        });
      } finally {
        await t.close();
      }
    }
  expect(factory.embeddingModel).not.toHaveBeenCalled();
  expect(logs.join("")).not.toContain(secret);
});
it("published request and wire examples validate with start/delta/finish and saved-before-finish semantics", async () => {
  const wire = media(streamPath, 200, "text/event-stream").example;
  expect(typeof wire).toBe("string");
  await frames(new Response(wire as string));
  const id = await conversation(),
    before = calls;
  const response = (
    await request(streamPath, id.toUpperCase(), 200, {
      project: p.toUpperCase(),
      body: example(streamPath),
      query: "?ignored=true",
      media: "application/json; charset=utf-8",
      origin: "https://web.example.invalid",
    })
  ).response;
  const events = await frames(response, async (event) => {
    if (event.type === "start") {
      expect(event.conversation_id).toBe(id);
      expect((await saved(event.user_message_id))!.raw_text).toBe("Summarize the attached note.");
    }
    if (event.type === "delta") finish();
    if (event.type === "finish")
      expect(await saved(event.message_id)).toMatchObject({
        raw_text: prefix,
        generation_status: "complete",
      });
  });
  expect(events.map((e) => e.type)).toEqual(["start", "delta", "finish"]);
  expect(calls).toBe(before + 1);
  const { rows, tasks } = await effects(id);
  expect(rows).toHaveLength(3);
  expect(tasks).toHaveLength(2);
  expect(tasks.every((r) => r.status === "queued")).toBe(true);
  const user = rows.find((r) => r.speaker === "user")!,
    file = rows.find((r) => r.speaker === "tool")!;
  expect(file.attachment).toMatchObject({
    parent_message_id: user.id,
    source_type: "PROJECT_FILE",
    path: "README.md",
  });
  expect(rows.every((r) => r.extracted_at === null)).toBe(true);
  expect(prompts.at(-1)).toContain("Offline project note.");
  expect(
    (await t.sql`select status,purpose from model_usage where conversation_id=${id}`)[0],
  ).toMatchObject({ status: "success", purpose: "chat" });
  const finishEvent = events.at(-1)!;
  expect(finishEvent.type).toBe("finish");
  const ack = await request(
    cancelPath,
    id,
    200,
    { body: example(cancelPath) },
    finishEvent.generation_id,
  );
  expect(ack.body).toMatchObject({
    generation_id: finishEvent.generation_id,
    message_id: finishEvent.generation_id,
    status: "complete",
  });
});
it("active cancel confirms saved interrupted prefix, then repeat receipt performs no model or message work", async () => {
  const id = await conversation();
  cite = true;
  const events = await frames(
    (await request(streamPath, id, 200, { body: { text: "cancel with citations" } })).response,
    async (event) => {
      if (event.type !== "delta") return;
      const ack = await request(cancelPath, id, 200, { body: {} }, event.generation_id);
      expect(ack.body).toMatchObject({
        generation_id: event.generation_id,
        message_id: event.generation_id,
        status: "interrupted",
      });
      expect(modelSignal!.aborted).toBe(true);
      expect(await saved(event.generation_id)).toMatchObject({
        raw_text: prefix,
        generation_status: "interrupted",
        memories: [vid],
      });
    },
  );
  const end = events.at(-1)!;
  expect(end).toMatchObject({
    type: "finish",
    status: "interrupted",
    memories: [{ value: null, belief_id: bid, belief_version_id: vid }],
  });
  if (end.type !== "finish") throw Error("missing finish acknowledgement");
  const { value: _value, ...missing } = end.memories[0]!;
  const eventValid = ajv.compile(
    jsonSchemaBounds(media(streamPath, 200, "text/event-stream").schema["x-sse-event-schema"]),
  );
  expect(eventValid({ ...end, memories: [missing] })).toBe(false);
  const before = calls,
    rows = (await effects(id)).rows.length;
  for (const body of [undefined, null, {}])
    expect(
      (
        await request(
          cancelPath,
          id,
          200,
          { body, query: "?ignored=true" },
          end.generation_id.toUpperCase(),
        )
      ).body!.status,
    ).toBe("interrupted");
  expect(calls).toBe(before);
  expect((await effects(id)).rows).toHaveLength(rows);
});
it.each(["length", "tool-calls"] as const)(
  "normal SDK finishReason=%s remains complete rather than claiming a stop-only guarantee",
  async (reason) => {
    mode = "complete";
    finishReason = reason;
    const id = await conversation();
    const events = await frames(
      (await request(streamPath, id, 200, { body: { text: "normal termination" } })).response,
    );
    expect(events.at(-1)).toMatchObject({ type: "finish", status: "complete" });
  },
);
it("file secrets are redacted before storage and SSE model input, with Evidence audit and queued work", async () => {
  mode = "complete";
  const id = await conversation();
  await frames(
    (
      await request(streamPath, id, 200, {
        body: {
          text: "file",
          attachments: [{ kind: "file", path: "README.md", content: secret, truncated: true }],
        },
      })
    ).response,
  );
  const { rows, tasks } = await effects(id),
    file = rows.find((r) => r.speaker === "tool")!;
  expect(file.raw_text).toContain("[REDACTED]");
  expect(JSON.stringify(rows)).not.toContain(secret);
  expect(prompts.at(-1)).not.toContain(secret);
  expect(tasks).toHaveLength(2);
  expect((await t.sql`select action,meta from audit_log where target=${file.id}`)[0]).toMatchObject(
    { action: "redact", meta: { count: 1 } },
  );
});
it.each(["error", "throw"] as const)(
  "upstream %s becomes fixed SSE error after HTTP200, failed persistence is readable without replay",
  async (failure) => {
    mode = failure;
    const id = await conversation(),
      before = calls;
    const events = await frames(
      (await request(streamPath, id, 200, { body: { text: "upstream rejection" } })).response,
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "GENERATION_FAILED" });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(calls).toBe(before + 1);
    const g = events[0]!.generation_id;
    expect(await saved(g)).toMatchObject({
      generation_status: "failed",
      raw_text: failure === "error" ? prefix : "",
    });
    expect((await request(cancelPath, id, 200, {}, g)).body!.status).toBe("failed");
    expect((await effects(id)).tasks).toHaveLength(1);
  },
);
it("same-project busy stream conflicts, foreign scope stays404, and foreign cancel cannot stop active generation", async () => {
  const id = await conversation(),
    before = calls;
  await frames(
    (await request(streamPath, id, 200, { body: { text: "busy" } })).response,
    async (event) => {
      if (event.type !== "delta") return;
      await request(streamPath, id, 409, { body: { text: "overlap" } });
      await request(streamPath, id, 404, { project: foreign, body: { text: "probe" } });
      await request(cancelPath, id, 404, { project: foreign, body: {} }, event.generation_id);
      expect(modelSignal!.aborted).toBe(false);
      finish();
    },
  );
  expect(calls).toBe(before + 1);
  expect((await effects(id)).rows).toHaveLength(2);
});
it("32 active registry entries reject a new scoped stream without admitting Evidence", async () => {
  const active: Generation[] = [];
  try {
    for (let i = 0; i < 32; i++) active.push(registry.start(p, uuidv7())!);
    const id = await conversation(),
      before = calls;
    const r = await request(streamPath, id, 409, { body: { text: "capacity" } });
    expect(r.body!.detail).toContain("32");
    expect(await effects(id)).toEqual({ rows: [], tasks: [] });
    expect(calls).toBe(before);
  } finally {
    active.forEach((g) => g.finish());
  }
});
it("archived and corrupt inherited history fail before user/file admission", async () => {
  const ended = await conversation(),
    broken = await conversation({
      resume: { version: 1, from: uuidv7(), message_ids: [uuidv7()] },
    });
  await t.sql`update conversations set ended_at=now() where id=${ended}`;
  const before = calls;
  for (const id of [ended, broken]) {
    await request(streamPath, id, 409, { body: { text: "not admitted" } });
    expect(await effects(id)).toEqual({ rows: [], tasks: [] });
  }
  expect(calls).toBe(before);
});
it.each([streamPath, cancelPath])(
  "UUID/body validation on %s leaves database and models untouched",
  async (path) => {
    const id = await conversation(),
      before = calls;
    await request(path, "bad", 400, { body: path === streamPath ? { text: "x" } : {} });
    await request(path, id, 400, {
      project: "bad",
      body: path === streamPath ? { text: "x" } : {},
    });
    const invalidBodies =
      path === streamPath
        ? [
            { text: "" },
            { text: "x", unknown: true },
            {
              text: "x",
              attachments: [{ kind: "file", path: "../escape", content: "x", truncated: false }],
            },
          ]
        : [[], false, { project_id: p }];
    for (const body of invalidBodies)
      expect((await request(path, id, 400, { body })).body!.errors!.length).toBeGreaterThan(0);
    if (path === cancelPath) await request(path, id, 400, { body: {} }, "bad");
    expect(await effects(id)).toEqual({ rows: [], tasks: [] });
    expect(calls).toBe(before);
  },
);
it("missing/foreign generation IDs and legacy/non-assistant rows do not count as cancellation receipts", async () => {
  const id = await conversation();
  for (const [speaker, status] of [
    ["user", "complete"],
    ["assistant", null],
  ] as const) {
    const mid = uuidv7();
    await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time,generation_status) values(${mid},${id},${speaker},'legacy',now(),${status})`;
    await request(cancelPath, id, 404, { body: {} }, mid);
  }
  await request(cancelPath, id, 404, { body: {} });
  await request(streamPath, uuidv7(), 404, { body: { text: "missing" } });
});
it.each([streamPath, cancelPath])(
  "transport parsing and size errors on %s use the published problem contract",
  async (path) => {
    const id = await conversation(),
      before = calls;
    await request(path, id, 400, { raw: "{broken" });
    await request(path, id, 400, { raw: "text", media: "text/plain" });
    await request(path, id, 415, { raw: "<xml/>", media: "text/xml" });
    await request(path, id, 413, { oversize: true });
    expect(await effects(id)).toEqual({ rows: [], tasks: [] });
    expect(calls).toBe(before);
  },
);
it.each([streamPath, cancelPath])(
  "auth and request budget for %s reject before malformed JSON or DB access",
  async (path) => {
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
    registerChatStreamRoutes(isolated, tripwire, TEST_MASTER_KEY, new ChatGenerations(), {
      factory,
      retrieveFn,
      onJob: () => {},
    });
    const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
    try {
      await request(path, uuidv7(), 401, { raw: "{broken", auth: false }, uuidv7(), address);
      const r = await request(path, uuidv7(), 429, { raw: "{broken" }, uuidv7(), address);
      expect(r.body!.code).toBe("RATE_LIMITED");
      expect(r.response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
      expect(reads).toBe(0);
    } finally {
      await isolated.close();
    }
  },
);
it.each(["database", "master key"])(
  "without %s neither stream nor cancel is registered",
  async (dependency) => {
    const isolated = buildApp({
      ...(dependency === "database" ? { masterKey: TEST_MASTER_KEY } : { db: t.db }),
      authToken: token,
      logStream: { write: () => {} },
    });
    const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
    try {
      for (const path of [streamPath, cancelPath])
        await request(
          path,
          uuidv7(),
          404,
          { body: path === streamPath ? { text: "x" } : {} },
          uuidv7(),
          address,
        );
    } finally {
      await isolated.close();
    }
  },
);
it.each(["exhausted", "unavailable"] as const)(
  "quota %s after start becomes HTTP200 plus GENERATION_FAILED, not a JSON quota error",
  async (reason) => {
    const isolated = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
    registerChatStreamRoutes(isolated, t.db, TEST_MASTER_KEY, new ChatGenerations(), {
      durableExtraction: true,
      factory,
      retrieveFn,
      onJob: () => {},
      admitModelCall: async () => {
        throw new ModelQuotaError(reason, 60);
      },
    });
    const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
    try {
      const id = await conversation(),
        before = calls;
      const events = await frames(
        (await request(streamPath, id, 200, { body: { text: "quota" } }, uuidv7(), address))
          .response,
      );
      expect(events.map((e) => e.type)).toEqual(["start", "error"]);
      expect(events.at(-1)).toMatchObject({ code: "GENERATION_FAILED" });
      expect(calls).toBe(before);
      expect((await effects(id)).rows.map((r) => r.speaker)).toEqual(["user", "assistant"]);
      expect((await effects(id)).tasks).toHaveLength(1);
      expect(await saved(events[0]!.generation_id)).toMatchObject({
        raw_text: "",
        generation_status: "failed",
      });
    } finally {
      await isolated.close();
    }
  },
);
it("failed assistant persistence emits PERSISTENCE_FAILED and active cancel500, then absence404", async () => {
  const id = await conversation();
  await t.sql`create function test119_fail_save() returns trigger language plpgsql as $$ begin raise exception 'private-test-db-error'; end $$`;
  await t.sql`create trigger test119_fail_save before insert on messages for each row when (new.speaker='assistant' and new.raw_text like 'partial119%') execute function test119_fail_save()`;
  try {
    const events = await frames(
      (await request(streamPath, id, 200, { body: { text: "save fails" } })).response,
      async (event) => {
        if (event.type === "delta")
          expect(
            (await request(cancelPath, id, 500, { body: {} }, event.generation_id)).body!.code,
          ).toBe("INTERNAL_ERROR");
      },
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "PERSISTENCE_FAILED" });
    expect(await saved(events[0]!.generation_id)).toBeUndefined();
    await request(cancelPath, id, 404, {}, events[0]!.generation_id);
    expect((await effects(id)).rows.map((r) => r.speaker)).toEqual(["user"]);
    expect((await effects(id)).tasks).toHaveLength(1);
    expect(logs.join("")).not.toContain("private-test-db-error");
  } finally {
    await t.sql`drop trigger test119_fail_save on messages`;
    await t.sql`drop function test119_fail_save()`;
  }
});

it("cancel during blocked preparation saves an empty interruption before any provider call", async () => {
  const isolated = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
  registerChatStreamRoutes(isolated, t.db, TEST_MASTER_KEY, new ChatGenerations(), {
    durableExtraction: true,
    factory,
    retrieveFn: () => new Promise(() => {}),
    onJob: () => {},
  });
  const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
  try {
    const id = await conversation(),
      before = calls;
    const events = await frames(
      (
        await request(
          streamPath,
          id,
          200,
          { body: { text: "cancel before model" } },
          uuidv7(),
          address,
        )
      ).response,
      async (event) => {
        if (event.type === "start")
          expect(
            (await request(cancelPath, id, 200, { body: {} }, event.generation_id, address)).body!
              .status,
          ).toBe("interrupted");
      },
    );
    expect(events.map((e) => e.type)).toEqual(["start", "finish"]);
    expect(await saved(events[0]!.generation_id)).toMatchObject({
      raw_text: "",
      generation_status: "interrupted",
    });
    expect(calls).toBe(before);
    expect((await effects(id)).tasks).toHaveLength(1);
  } finally {
    await isolated.close();
  }
});
it("server deadline also confirms interrupted state for an upstream with no deltas", async () => {
  mode = "silent";
  const isolated = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
  registerChatStreamRoutes(
    isolated,
    t.db,
    TEST_MASTER_KEY,
    new ChatGenerations(),
    { durableExtraction: true, factory, retrieveFn, onJob: () => {} },
    40,
  );
  const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
  try {
    const id = await conversation();
    const events = await frames(
      (await request(streamPath, id, 200, { body: { text: "deadline" } }, uuidv7(), address))
        .response,
    );
    expect(events.at(-1)).toMatchObject({ type: "finish", status: "interrupted" });
    expect(await saved(events[0]!.generation_id)).toMatchObject({
      raw_text: "",
      generation_status: "interrupted",
    });
  } finally {
    await isolated.close();
  }
});
it("local disconnect is unconfirmed until a separate scoped receipt confirms persisted interruption", async () => {
  const id = await conversation(),
    seen: ChatStreamEvent[] = [];
  const disconnected = Error("test-local-disconnect");
  const result = await frames(
    (await request(streamPath, id, 200, { body: { text: "disconnect" }, unpooled: true })).response,
    async (event) => {
      seen.push(event);
      if (event.type === "delta") throw disconnected;
    },
  ).catch((error: unknown) => error);
  expect(result).toBe(disconnected);
  expect(seen.map((e) => e.type)).toEqual(["start", "delta"]);
  const ack = await request(cancelPath, id, 200, { body: {} }, seen[0]!.generation_id);
  expect(ack.body!.status).toBe("interrupted");
  expect(await saved(seen[0]!.generation_id)).toMatchObject({
    generation_status: "interrupted",
    raw_text: prefix,
  });
});
it("cancellation can be request-rate-limited without aborting the active provider", async () => {
  const isolated = buildApp({
    db: t.db,
    authToken: token,
    rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } },
    logStream: { write: () => {} },
  });
  const active = new ChatGenerations();
  registerChatStreamRoutes(isolated, t.db, TEST_MASTER_KEY, active, {
    durableExtraction: true,
    factory,
    retrieveFn,
    onJob: () => {},
  });
  const address = await isolated.listen({ host: "127.0.0.1", port: 0 });
  try {
    const id = await conversation();
    const events = await frames(
      (
        await request(
          streamPath,
          id,
          200,
          { body: { text: "limited cancellation" } },
          uuidv7(),
          address,
        )
      ).response,
      async (event) => {
        if (event.type !== "delta") return;
        expect(
          (await request(cancelPath, id, 429, { body: {} }, event.generation_id, address)).body!
            .code,
        ).toBe("RATE_LIMITED");
        expect(modelSignal!.aborted).toBe(false);
        finish();
      },
    );
    expect(events.at(-1)).toMatchObject({ type: "finish", status: "complete" });
  } finally {
    await isolated.close();
  }
});
