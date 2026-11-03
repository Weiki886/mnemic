import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  ApprovalAuditEvent,
  ApprovalAuditRecord,
  ApprovalAuditPage,
} from "@mnemic/shared/approval-audit";
import { buildApp } from "../src/app.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { requestOversizeHeaders } from "./fixtures/oversize-request.js";
const path = "/projects/{projectId}/approvals";
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
ajv.addSchema({ components: doc.components }, "approval");
const p = uuidv7(),
  other = uuidv7(),
  token = "approval-contract-offline-token-00000",
  headers = { authorization: `Bearer ${token}` };
const secret = "sk-approval-plaintext-secret-123456789012345678901234",
  logs: string[] = [];
const models = vi.fn(() => {
  throw Error("approval audit must never resolve or invoke models");
});
let t: TestDb, app: ReturnType<typeof buildApp>, base: string;
function validate(schema: unknown, body: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"approval#/components/')),
  );
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
function event(project = p): ApprovalAuditEvent {
  return {
    event_id: uuidv7(),
    request_id: uuidv7(),
    project_id: project,
    session_id: uuidv7(),
    mode: "confirm",
    operation: "file.create",
    decision: "allow",
    reason: "confirmed",
    scope: "once",
    root_hash: "a".repeat(64),
    target_hash: "b".repeat(64),
    target_basis: "canonical",
  };
}
function example() {
  const body = doc.paths[path]!.post!.requestBody as {
    content: Record<string, { schema: unknown; example: ApprovalAuditEvent }>;
  };
  const media = body.content["application/json"]!;
  validate(media.schema, media.example);
  return { ...media.example, event_id: uuidv7(), project_id: p };
}
async function request<T = unknown>(
  method: "get" | "post",
  status: number,
  opts: {
    body?: unknown;
    raw?: string;
    media?: string;
    project?: string;
    query?: string;
    auth?: boolean;
    oversize?: boolean;
    origin?: string;
  } = {},
  origin = base,
) {
  const url = origin + path.replace("{projectId}", opts.project ?? p) + (opts.query ?? "");
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
        method: method.toUpperCase(),
        headers: h,
        ...(opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : opts.raw !== undefined
            ? { body: opts.raw }
            : {}),
      });
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("content-type")).toContain(
    status < 400 ? "application/json" : "application/problem+json",
  );
  expect(r.headers.get("x-request-id")).toBeTruthy();
  const res = doc.paths[path]![method]!.responses[String(status)] as
    { content: Record<string, { schema: unknown }> } | undefined;
  expect(res, `undocumented ${method} ${status}`).toBeTruthy();
  validate(Object.values(res!.content)[0]!.schema, body);
  if (status === 200 || status === 201) expect(r.headers.get("cache-control")).toBe("no-store");
  return { body: body as T, response: r };
}
async function insertReceipt(e: ApprovalAuditEvent, ts = "2026-10-01T00:00:00Z") {
  await t.sql`insert into audit_log(id,ts,actor,action,target,decision,meta) values (${e.event_id},${ts},'cli',${`approval.${e.operation ?? "invalid"}`},${e.target_hash ? `sha256:${e.target_hash}` : null},${e.decision},${JSON.stringify({ ...e, client_reported: true, version: 1 })}::jsonb)`;
}
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${p},'approval-contract'),(${other},'other-approval-contract')`;
  app = buildApp({
    db: t.db,
    authToken: token,
    providerFactory: { languageModel: models, embeddingModel: models },
    corsOrigin: "https://web.example.invalid",
    logStream: {
      write: (s) => {
        logs.push(s);
      },
    },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  try {
    await app?.close();
    if (t) {
      await t.sql`delete from audit_log where meta->>'project_id' in (${p},${other})`;
      await t.sql`delete from projects where id in (${p},${other})`;
    }
  } finally {
    await t?.close();
  }
  expect(models).not.toHaveBeenCalled();
});
it("published approval example persists exact metadata and identical normalized retries return the original receipt", async () => {
  const payload = example();
  const { body: first, response } = await request<ApprovalAuditRecord>("post", 201, {
    body: payload,
    query: "?ignored=true",
    origin: "https://web.example.invalid",
  });
  expect(first.event).toEqual(payload);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://web.example.invalid");
  const [row] =
    await t.sql`select actor,action,target,decision,meta,ts from audit_log where id=${payload.event_id}`;
  expect(row).toMatchObject({
    actor: "cli",
    action: "approval.file.create",
    target: `sha256:${payload.target_hash}`,
    decision: "allow",
    meta: { ...payload, client_reported: true, version: 1 },
  });
  expect(first.recorded_at).toBe(new Date(row!.ts).toISOString());
  const reversed = Object.fromEntries(
    Object.entries({
      ...payload,
      event_id: payload.event_id.toUpperCase(),
      project_id: p.toUpperCase(),
      request_id: payload.request_id.toUpperCase(),
      session_id: payload.session_id.toUpperCase(),
    }).reverse(),
  );
  const repeat = await request<ApprovalAuditRecord>("post", 200, {
    body: reversed,
    project: p.toUpperCase(),
  });
  expect(repeat.body).toEqual(first);
  expect(await t.sql`select id from audit_log where id=${payload.event_id}`).toHaveLength(1);
  const conflict = await request("post", 409, {
    body: { ...payload, decision: "deny", reason: "denied", scope: undefined },
  });
  expect(JSON.stringify(conflict.body)).not.toContain(payload.target_hash!);
  expect(
    (await t.sql`select decision from audit_log where id=${payload.event_id}`)[0]!.decision,
  ).toBe("allow");
});
it("simultaneous identical audit submissions create one row with one201 and stable200 receipts", async () => {
  const payload = event();
  const out = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const r = await fetch(base + path.replace("{projectId}", p), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const b = (await r.json()) as ApprovalAuditRecord;
      expect([200, 201]).toContain(r.status);
      const res = doc.paths[path]!.post!.responses[String(r.status)] as {
        content: Record<string, { schema: unknown }>;
      };
      validate(res.content["application/json"]!.schema, b);
      return { status: r.status, body: b };
    }),
  );
  expect(out.filter((x) => x.status === 201)).toHaveLength(1);
  expect(out.filter((x) => x.status === 200)).toHaveLength(7);
  expect(out.every((x) => JSON.stringify(x.body) === JSON.stringify(out[0]!.body))).toBe(true);
  expect(await t.sql`select id from audit_log where id=${payload.event_id}`).toHaveLength(1);
});
it("published list parameters select stable offset pages and exclude foreign/platform/unmarked records", async () => {
  const events = [event(other), event(other), event(other)];
  for (const [i, e] of events.entries())
    await insertReceipt(e, `2026-10-01T00:00:00.${i < 2 ? "123456" : "123457"}Z`);
  const hidden = uuidv7();
  await t.sql`insert into audit_log(id,actor,action,decision,meta) values(${hidden},'gate','redact','redacted',${JSON.stringify({ project_id: other })}::jsonb)`;
  const unmarked = uuidv7();
  await t.sql`insert into audit_log(id,actor,action,decision,meta) values(${unmarked},'cli','approval.invalid','deny',${JSON.stringify({ project_id: other })}::jsonb)`;
  const op = doc.paths[path]!.get!;
  const params = op.parameters as {
    in: string;
    name: string;
    example?: unknown;
    schema: unknown;
  }[];
  const q = new URLSearchParams();
  for (const param of params) {
    if (param.example !== undefined) {
      validate(param.schema, param.example);
      if (param.in === "query") q.set(param.name, String(param.example));
    }
  }
  expect(q.get("limit")).toBe("2");
  const full = await request<ApprovalAuditPage>("get", 200, { project: other });
  expect(full.body).toMatchObject({ limit: 50, offset: 0 });
  expect(full.body.items.map((x) => x.event.event_id)).toEqual(events.map((e) => e.event_id));
  const a = await request<ApprovalAuditPage>("get", 200, { project: other, query: "?" + q });
  const b = await request<ApprovalAuditPage>("get", 200, {
    project: other,
    query: "?limit=0002&offset=0002",
  });
  expect([...a.body.items, ...b.body.items]).toEqual(full.body.items);
  expect(b.body).toMatchObject({ limit: 2, offset: 2 });
  expect(full.body.items.map((x) => x.recorded_at)).toEqual(
    Array(3).fill("2026-10-01T00:00:00.123Z"),
  );
  expect(
    (await request<ApprovalAuditPage>("get", 200, { query: "?limit=200&offset=9007199254740991" }))
      .body.items,
  ).toEqual([]);
});
it("denied invalid requests retain null operation/target while shell decisions retain only hashes", async () => {
  const { scope: _s, ...raw } = event();
  const invalid: ApprovalAuditEvent = {
    ...raw,
    decision: "deny",
    reason: "invalid_request",
    operation: null,
    target_hash: null,
    target_basis: "none",
  };
  expect((await request<ApprovalAuditRecord>("post", 201, { body: invalid })).body.event).toEqual(
    invalid,
  );
  const shell: ApprovalAuditEvent = {
    ...event(),
    operation: "shell",
    command_hash: "c".repeat(64),
  };
  expect((await request<ApprovalAuditRecord>("post", 201, { body: shell })).body.event).toEqual(
    shell,
  );
});
it("project scope is checked before insert; foreign URL or missing project returns404 with no write", async () => {
  const payload = event();
  await request("post", 404, { project: other, body: payload });
  await request("post", 404, { project: uuidv7(), body: payload });
  expect(await t.sql`select id from audit_log where id=${payload.event_id}`).toEqual([]);
  await request("get", 404, { project: uuidv7() });
});
it("colliding platform or foreign-project event IDs return409 without exposing or replacing stored metadata", async () => {
  const payload = event();
  await t.sql`insert into audit_log(id,actor,action,target,decision,meta) values(${payload.event_id},'server','custom.test',${p},'retained',${JSON.stringify({ project_id: p, private: secret })}::jsonb)`;
  const collision = await request("post", 409, { body: payload });
  expect(JSON.stringify(collision.body)).not.toContain(secret);
  expect(
    (await t.sql`select meta from audit_log where id=${payload.event_id}`)[0]!.meta.private,
  ).toBe(secret);
  const foreign = event(other);
  await insertReceipt(foreign);
  const conflicting = await request("post", 409, { body: { ...foreign, project_id: p } });
  expect(JSON.stringify(conflicting.body)).not.toContain(other);
});
it.each([
  "?extra=1",
  "?limit=201",
  "?limit=0",
  "?limit=1.5",
  "?limit=1e2",
  "?offset=",
  "?offset=-1",
  "?offset=9007199254740992",
  "?limit=1&limit=2",
])("query validation %s produces structured400", async (query) => {
  const { body } = await request<{ errors: unknown[] }>("get", 400, { query });
  expect(body.errors.length).toBeGreaterThan(0);
});
it.each(["get", "post"] as const)(
  "%s validates project UUID with structured400",
  async (method) => {
    const { body } = await request<{ errors: { path: string }[] }>(method, 400, {
      project: "bad",
      ...(method === "post" ? { body: event() } : {}),
    });
    expect(body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "projectId" })]),
    );
  },
);
it.each([
  { name: "plaintext keys", edit: { command: secret, target: "/private/key" } },
  { name: "client markers", edit: { client_reported: true, version: 1 } },
  { name: "nonhash", edit: { target_hash: "/private/key" } },
  { name: "allow null target", edit: { target_hash: null, target_basis: "none" } },
  { name: "deny with allow reason", edit: { decision: "deny" } },
  { name: "shell missing command hash", edit: { operation: "shell" } },
  { name: "nonshell command hash", edit: { command_hash: "c".repeat(64) } },
  { name: "destructive grant reuse", edit: { operation: "file.delete", scope: "permanent" } },
])("body rejects $name without persistence or plaintext logs", async ({ edit }) => {
  const payload = { ...event(), ...edit };
  const { body } = await request<{ errors: unknown[] }>("post", 400, { body: payload });
  expect(body.errors.length).toBeGreaterThan(0);
  expect(await t.sql`select id from audit_log where id=${payload.event_id}`).toEqual([]);
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(logs.join("")).not.toContain(secret);
});
it("parsing, media and size failures occur before a new audit event is persisted", async () => {
  await request("post", 400, { raw: "{broken" });
  await request("post", 400);
  await request("post", 400, { raw: "text", media: "text/plain" });
  await request("post", 415, { raw: "<body/>", media: "text/xml" });
  await request("post", 413, { oversize: true });
  const charset = await request<ApprovalAuditRecord>("post", 201, {
    raw: JSON.stringify(event()),
    media: "application/json; charset=utf-8",
  });
  expect(charset.body.event.project_id).toBe(p);
});
it("incompatible selected history fails the whole page with fixed500 rather than leaking arbitrary metadata", async () => {
  const e = event();
  await insertReceipt(e);
  await t.sql`update audit_log set meta=meta || ${JSON.stringify({ unexpected: secret })}::jsonb where id=${e.event_id}`;
  try {
    const { body } = await request<{ detail: string }>("get", 500);
    expect(body.detail).toBe("服务器内部错误");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(logs.join("")).not.toContain(secret);
  } finally {
    await t.sql`delete from audit_log where id=${e.event_id}`;
  }
});
it("authentication precedes JSON validation and database access for both methods", async () => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get: () => {
      reads++;
      throw Error("not reached");
    },
  });
  const denied = buildApp({ db, authToken: token, logStream: { write: () => {} } });
  const origin = await denied.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request("get", 401, { project: "bad", query: "?extra=1", auth: false }, origin);
    await request("post", 401, { project: "bad", raw: "{broken", auth: false }, origin);
    expect(reads).toBe(0);
  } finally {
    await denied.close();
  }
});
it("database failure is fixed500 and rate rejection429 skips later database access", async () => {
  let reads = 0;
  const localLogs: string[] = [];
  const db = new Proxy({} as PostgresJsDatabase, {
    get: () => {
      reads++;
      throw Error(secret);
    },
  });
  const failed = buildApp({
    db,
    authToken: token,
    rateLimit: { ip: { capacity: 2, refillPerSecond: 0.001 } },
    logStream: {
      write: (s) => {
        localLogs.push(s);
      },
    },
  });
  const origin = await failed.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const method of ["get", "post"] as const) {
      const r = await request<{ detail: string }>(
        method,
        500,
        method === "post" ? { body: event() } : {},
        origin,
      );
      expect(r.body.detail).toBe("服务器内部错误");
    }
    const before = reads;
    const r = await request("post", 429, { body: event() }, origin);
    expect(r.response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(reads).toBe(before);
    expect(localLogs.join("")).not.toContain(secret);
  } finally {
    await failed.close();
  }
});
it("both methods are absent without a configured database", async () => {
  const bare = buildApp({ authToken: token, logStream: { write: () => {} } });
  const origin = await bare.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request("get", 404, {}, origin);
    await request("post", 404, { body: event() }, origin);
  } finally {
    await bare.close();
  }
});

it("an existing project without decision receipts returns an empty default page", async () => {
  const empty = uuidv7();
  await t.sql`insert into projects(id,name) values(${empty},'empty-approval-contract')`;
  try {
    expect((await request<ApprovalAuditPage>("get", 200, { project: empty })).body).toEqual({
      items: [],
      limit: 50,
      offset: 0,
    });
  } finally {
    await t.sql`delete from projects where id=${empty}`;
  }
});
