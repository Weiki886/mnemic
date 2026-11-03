import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { requestOversizeHeaders } from "./fixtures/oversize-request.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
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
ajv.addSchema({ components: doc.components }, "pending");
const token = "pending-contract-offline-token-000000",
  headers = { authorization: `Bearer ${token}` };
const foreignMessageId = uuidv7();
const projectId = uuidv7(),
  foreign = uuidv7(),
  messageId = uuidv7();
const confirm = "/pending/{id}/confirm",
  reject = "/pending/{id}/reject";
const models = vi.fn(() => {
  throw Error("PENDING must never resolve or invoke models");
});
let t: TestDb, app: ReturnType<typeof buildApp>, base: string;
type Row = {
  id: string;
  projectId: string;
  candidate: unknown;
  gateScores: unknown;
  status: string;
  evidenceId: string;
  createdAt: string;
  ttlExpiresAt: string;
  decidedAt: string | null;
};
function validate(schema: unknown, body: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"pending#/components/')),
  );
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
async function request<T = unknown>(
  path: string,
  method: "get" | "post",
  status: number,
  opts: {
    id?: string;
    query?: string;
    raw?: string;
    media?: string;
    auth?: boolean;
    oversize?: boolean;
    origin?: string;
  } = {},
  originBase = base,
) {
  const url = originBase + path.replace("{id}", opts.id ?? uuidv7()) + (opts.query ?? "");
  const h = {
    ...(opts.auth === false ? {} : headers),
    ...(opts.raw !== undefined || opts.oversize
      ? { "content-type": opts.media ?? "application/json" }
      : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
  const r = opts.oversize
    ? await requestOversizeHeaders(url, h, 1048577)
    : await fetch(url, {
        method: method.toUpperCase(),
        headers: h,
        ...(opts.raw !== undefined ? { body: opts.raw } : {}),
      });
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("content-type")).toContain(
    status < 400 ? "application/json" : "application/problem+json",
  );
  expect(r.headers.get("x-request-id")).toBeTruthy();
  const response = doc.paths[path]?.[method]?.responses[String(status)] as
    { content: Record<string, { schema: unknown }> } | undefined;
  expect(response, `undocumented ${path} ${status}`).toBeTruthy();
  validate(Object.values(response!.content)[0]!.schema, body);
  return { body: body as T, response: r };
}
async function seed(
  status = "pending",
  candidate: unknown = { subject: "p", value: "Redis" },
  gateScores: unknown = { confidence: 0.5 },
  project = projectId,
  at = "2026-11-02T00:00:00Z",
) {
  const id = uuidv7();
  await t.sql`insert into pending_candidates (id,project_id,candidate,gate_scores,status,ttl_expires_at,evidence_id,created_at) values (${id},${project},${JSON.stringify(candidate)}::jsonb,${JSON.stringify(gateScores)}::jsonb,${status},'2020-01-01',${project === foreign ? foreignMessageId : messageId},${at})`;
  return id;
}
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects (id,name) values (${projectId},'pending-contract'),(${foreign},'foreign-pending')`;
  const cid = uuidv7();
  await t.sql`insert into conversations (id,project_id) values (${cid},${projectId})`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time) values (${messageId},${cid},'user','source text',now())`;
  const foreignConversation = uuidv7();
  await t.sql`insert into conversations (id,project_id) values (${foreignConversation},${foreign})`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time) values (${foreignMessageId},${foreignConversation},'user','foreign source',now())`;
  app = buildApp({
    db: t.db,
    authToken: token,
    providerFactory: { languageModel: models, embeddingModel: models },
    debugMode: true,
    corsOrigin: "https://web.example.invalid",
    logStream: { write: () => {} },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  try {
    await app?.close();
    if (t) {
      await t.sql`delete from pending_candidates where project_id in (${projectId},${foreign})`;
      await t.sql`delete from messages where conversation_id in (select id from conversations where project_id in (${projectId},${foreign}))`;
      await t.sql`delete from conversations where project_id in (${projectId},${foreign})`;
      await t.sql`delete from projects where id in (${projectId},${foreign})`;
    }
  } finally {
    await t?.close();
  }
  expect(models).not.toHaveBeenCalled();
});
it("published list parameter example filters project and defaults to pending without TTL expiry or pagination", async () => {
  const own = await seed("pending", { value: "oldest" }, {}, projectId, "2026-10-01T00:00:00Z");
  const newer = await seed("pending", { value: "newer" }, {}, projectId, "2026-10-02T00:00:00Z");
  const hidden = await seed("pending", { value: "foreign-marker" }, {}, foreign);
  await seed("confirmed");
  const op = doc.paths["/pending"]!.get!;
  const params = op.parameters as { name: string; example: string; schema: unknown }[];
  const parameter = params.find((p) => p.name === "project_id")!;
  validate(parameter.schema, parameter.example);
  const query = new URLSearchParams({ project_id: parameter.example });
  const result = await request<Row[]>("/pending", "get", 200, {
    query: `?${query.toString().replace(parameter.example, projectId)}&limit=1&offset=999&extra=ignored`,
  });
  expect(result.body.map((r) => r.id)).toEqual([own, newer]);
  expect(result.body.map((r) => r.id)).not.toContain(hidden);
  expect(result.body[0]).toMatchObject({
    status: "pending",
    evidenceId: messageId,
    decidedAt: null,
    candidate: { value: "oldest" },
  });
  expect(result.response.headers.get("cache-control")).toBeNull();
  expect(JSON.stringify(result.body)).not.toContain("foreign-marker");
});
it.each(["pending", "confirmed", "expired", "rejected", "promoted"])(
  "status filter %s preserves arbitrary JSONB and no side effects",
  async (status) => {
    const id = await seed(status, null, [null, false, 0]);
    const { body } = await request<Row[]>("/pending", "get", 200, {
      query: `?project_id=${projectId}&status=${status}`,
    });
    expect(body.find((r) => r.id === id)).toMatchObject({
      candidate: null,
      gateScores: [null, false, 0],
      status,
    });
    expect(body.every((r) => r.projectId === projectId && r.status === status)).toBe(true);
  },
);
it("nonexistent project gives empty list and uppercase UUID still selects the same project", async () => {
  expect(
    (await request("/pending", "get", 200, { query: `?project_id=${uuidv7()}` })).body,
  ).toEqual([]);
  const a = await request("/pending", "get", 200, { query: `?project_id=${projectId}` });
  const b = await request("/pending", "get", 200, {
    query: `?project_id=${projectId.toUpperCase()}`,
  });
  expect(b.body).toEqual(a.body);
});
it("published decision path examples perform global status updates without ingesting memory", async () => {
  const id = await seed("expired", ["historical", null], false);
  for (const path of [confirm, reject]) {
    const params = doc.paths[path]!.post!.parameters as {
      name: string;
      example: string;
      schema: unknown;
    }[];
    const parameter = params.find((p) => p.name === "id")! as { example: string; schema: unknown };
    validate(parameter.schema, parameter.example);
  }
  const result = await request<Row>(confirm, "post", 200, { id, query: `?project_id=${foreign}` });
  expect(result.body).toMatchObject({
    id,
    projectId,
    status: "confirmed",
    candidate: ["historical", null],
    gateScores: false,
  });
  expect(result.body.decidedAt).not.toBeNull();
  const previous = "2000-01-01T00:00:00.000Z";
  await t.sql`update pending_candidates set decided_at=${previous} where id=${id}`;
  const repeat = await request<Row>(confirm, "post", 200, { id, raw: '"any JSON is ignored"' });
  expect(repeat.body.decidedAt).not.toBe(previous);
  const reversed = await request<Row>(reject, "post", 200, {
    id,
    raw: '{"project_id":"ignored","status":"promoted"}',
    origin: "https://web.example.invalid",
  });
  expect(reversed.body.status).toBe("rejected");
  expect(reversed.response.headers.get("access-control-allow-origin")).toBe(
    "https://web.example.invalid",
  );
  const stored = (await t.sql`select status,decided_at from pending_candidates where id=${id}`)[0]!;
  expect(stored.status).toBe("rejected");
  expect(new Date(stored.decided_at as Date).toISOString()).toBe(reversed.body.decidedAt);
  const counts = (
    await t.sql`select
    (select count(*)::int from observations where evidence_id=${messageId}) as observations,
    (select count(*)::int from beliefs where project_id=${projectId}) as beliefs,
    (select count(*)::int from memory_tasks where project_id=${projectId}) as tasks`
  )[0];
  expect(counts).toEqual({ observations: 0, beliefs: 0, tasks: 0 });
});
it.each([
  "?",
  "?project_id=bad",
  `?project_id=${projectId}&status=active`,
  `?project_id=${projectId}&status=pending&status=confirmed`,
])("invalid query %s produces structured400", async (query) => {
  const { body } = await request<{ errors: unknown[] }>("/pending", "get", 400, { query });
  expect(body.errors.length).toBeGreaterThan(0);
});
it.each([confirm, reject])(
  "%s missing and malformed IDs use legacy404, not a UUID validation400",
  async (path) => {
    await request(path, "post", 404);
    await request(path, "post", 404, { id: "not-a-uuid" });
  },
);
it.each([confirm, reject])(
  "%s enforces JSON parsing/media/size despite ignoring body contents",
  async (path) => {
    const id = await seed();
    await request(path, "post", 400, { id, raw: "{broken" });
    await request(path, "post", 415, { id, raw: "<body/>", media: "text/xml" });
    await request(path, "post", 413, { id, oversize: true });
    expect(
      (await t.sql`select status,decided_at from pending_candidates where id=${id}`)[0],
    ).toEqual({ status: "pending", decided_at: null });
  },
);
it("authentication precedes JSON and database access on all three operations", async () => {
  let reads = 0;
  const broken = new Proxy({} as PostgresJsDatabase, {
    get: () => {
      reads++;
      throw Error("DB must not be touched");
    },
  });
  const denied = buildApp({ db: broken, authToken: token, logStream: { write: () => {} } });
  const origin = await denied.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request("/pending", "get", 401, { auth: false }, origin);
    for (const path of [confirm, reject])
      await request(path, "post", 401, { auth: false, raw: "{broken", id: "bad" }, origin);
    expect(reads).toBe(0);
  } finally {
    await denied.close();
  }
});
it("legacy broad catch maps repository failures to404 while list failures remain fixed500", async () => {
  const secret = "sk-pending-database-secret-123456789012345678901234";
  const logs: string[] = [];
  const broken = new Proxy({} as PostgresJsDatabase, {
    get: () => {
      throw Error(secret);
    },
  });
  const failed = buildApp({
    db: broken,
    authToken: token,
    logStream: {
      write: (text) => {
        logs.push(text);
      },
    },
  });
  const origin = await failed.listen({ host: "127.0.0.1", port: 0 });
  try {
    const { body } = await request<{ detail: string }>(
      "/pending",
      "get",
      500,
      { query: `?project_id=${projectId}` },
      origin,
    );
    expect(body.detail).toBe("服务器内部错误");
    for (const path of [confirm, reject]) {
      const result = await request(path, "post", 404, {}, origin);
      expect(JSON.stringify(result.body)).not.toContain(secret);
    }
    expect(logs.join("")).not.toContain(secret);
  } finally {
    await failed.close();
  }
});
it("HTTP rate rejection has documented429 Retry-After and no second database access", async () => {
  let reads = 0;
  const broken = new Proxy({} as PostgresJsDatabase, {
    get: () => {
      reads++;
      throw Error("offline");
    },
  });
  const limited = buildApp({
    db: broken,
    authToken: token,
    rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } },
    logStream: { write: () => {} },
  });
  const origin = await limited.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request("/pending", "get", 500, { query: `?project_id=${projectId}` }, origin);
    const before = reads;
    const { response } = await request(
      "/pending",
      "get",
      429,
      { query: `?project_id=${projectId}` },
      origin,
    );
    expect(response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(reads).toBe(before);
  } finally {
    await limited.close();
  }
});

it("routes are absent without DB and return documented404 rather than a fabricated empty list", async () => {
  const bare = buildApp({ authToken: token, logStream: { write: () => {} } });
  const origin = await bare.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request("/pending", "get", 404, { query: `?project_id=${projectId}` }, origin);
    for (const path of [confirm, reject]) await request(path, "post", 404, {}, origin);
  } finally {
    await bare.close();
  }
});
it("existing text/plain parser and JSON charset work without introducing a JSON-only policy", async () => {
  const id = await seed();
  expect(
    (await request<Row>(confirm, "post", 200, { id, media: "text/plain", raw: "ignored text" }))
      .body.status,
  ).toBe("confirmed");
  expect(
    (
      await request<Row>(reject, "post", 200, {
        id,
        media: "application/json; charset=utf-8",
        raw: "[]",
      })
    ).body.status,
  ).toBe("rejected");
});
