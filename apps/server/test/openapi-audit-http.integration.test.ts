import { jsonSchemaBounds } from "./fixtures/oas30-bounds.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { buildApp } from "../src/app.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
const path = "/v1/audit-log",
  p = uuidv7(),
  other = uuidv7();
const ids = Array.from({ length: 15 }, () => uuidv7());
const from = "2198-06-07T08:09:10.123Z",
  to = "2198-06-07T08:09:10.124Z";
const secret = "sk-audit-private-123456789012345678901234",
  token = "audit-contract-offline-0000000000000",
  headers = { authorization: `Bearer ${token}` };
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
        Object.entries(doc.components?.schemas ?? {}).map(([name, schema]) => [
          name,
          jsonSchemaBounds(schema),
        ]),
      ),
    },
  },
  "audit",
);
const models = vi.fn(() => {
    throw Error("audit read must never resolve or invoke models");
  }),
  logs: string[] = [];
let t: TestDb, app: ReturnType<typeof buildApp>, base: string;
type Row = {
  id: string;
  ts: string;
  actor: string | null;
  action: string | null;
  target: string | null;
  decision: string | null;
  meta: Record<string, unknown> | null;
  metadata_omitted: boolean;
};
type Page = { from: string; to: string; limit: number; items: Row[]; next_after: string | null };
function bounds(extra: Record<string, string> = {}) {
  return new URLSearchParams({ from, to, ...extra }).toString();
}
function validate(schema: unknown, value: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"audit#/components/')),
  );
  expect(v(value), JSON.stringify(v.errors)).toBe(true);
}
async function request<T = Page>(status: number, query = bounds(), auth = true, origin = base) {
  const r = await fetch(origin + path + "?" + query, { headers: auth ? headers : {} });
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("content-type")).toContain(
    status < 400 ? "application/json" : "application/problem+json",
  );
  expect(r.headers.get("x-request-id")).toBeTruthy();
  const response = doc.paths[path]!.get!.responses[String(status)] as
    { content: Record<string, { schema: unknown }> } | undefined;
  expect(response, `undocumented ${status}`).toBeTruthy();
  validate(Object.values(response!.content)[0]!.schema, body);
  if (status === 200 || status === 400) expect(r.headers.get("cache-control")).toBe("no-store");
  return { body: body as T, response: r };
}
beforeAll(async () => {
  t = await setupTestDb();
  const event = {
    event_id: ids[7],
    request_id: uuidv7(),
    project_id: p,
    session_id: uuidv7(),
    mode: "confirm",
    operation: "file.create",
    decision: "allow",
    reason: "confirmed",
    scope: "once",
    root_hash: "a".repeat(64),
    target_hash: "b".repeat(64),
    target_basis: "canonical",
    client_reported: true,
    version: 1,
  };
  const rows = [
    {
      actor: "server",
      action: "provider.create",
      target: p,
      decision: "created",
      meta: { version: 1, protocol: "openai-compatible", slots: ["chat"] },
    },
    {
      actor: "server",
      action: "provider.update",
      target: p,
      decision: "updated",
      meta: {
        version: 1,
        changed_fields: ["name"],
        before_protocol: "openai-compatible",
        after_protocol: "anthropic",
      },
    },
    {
      actor: "server",
      action: "belief.delete",
      target: p,
      decision: "updated",
      meta: { version: 1, project_id: p, before: "active", after: "deleted" },
    },
    {
      actor: "server",
      action: "belief.restore",
      target: p,
      decision: "updated",
      meta: { version: 1, project_id: p, before: "deleted", after: "active" },
    },
    {
      actor: "server",
      action: "flags.update",
      target: "server",
      decision: "updated",
      meta: {
        schema_version: 1,
        previous_revision: 0,
        revision: 1,
        before: DEFAULT_FEATURE_FLAGS,
        after: { ...DEFAULT_FEATURE_FLAGS, memory_gate: false },
      },
    },
    {
      actor: "server",
      action: "usage.export",
      target: p,
      decision: "prepared",
      meta: {
        version: 1,
        project_id: p,
        conversation_id: null,
        format: "json",
        rows: 0,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        after: null,
        next_after: null,
      },
    },
    {
      actor: "gate",
      action: "redact",
      target: "candidate.value",
      decision: "redacted",
      meta: { pattern: "github_pat", count: 2 },
    },
    {
      actor: "cli",
      action: "approval.file.create",
      target: `sha256:${"b".repeat(64)}`,
      decision: "allow",
      meta: event,
    },
    {
      actor: "server",
      action: "future.unknown",
      target: p,
      decision: "future",
      meta: { project_id: p, secret },
    },
    {
      actor: "cli",
      action: "approval.shell",
      target: `sha256:${"b".repeat(64)}`,
      decision: "allow",
      meta: { ...event, event_id: ids[9] },
    },
    {
      actor: "server",
      action: "provider.create",
      target: p,
      decision: "created",
      meta: { project_id: p, padding: "中".repeat(22000), secret },
    },
    {
      actor: "x".repeat(65),
      action: "provider.create",
      target: p,
      decision: "created",
      meta: { project_id: p, secret },
    },
    {
      actor: "cli",
      action: "approval.file.create",
      target: `sha256:${"b".repeat(64)}`,
      decision: "allow",
      meta: { ...event, event_id: ids[12], client_reported: false },
    },
    {
      actor: "server",
      action: "belief.delete",
      target: other,
      decision: "updated",
      meta: { version: 1, project_id: other, before: "active", after: "deleted" },
    },
    {
      actor: "server",
      action: "future.unknown",
      target: p,
      decision: "future",
      meta: { project_id: p, secret },
    },
  ];
  for (const [i, row] of rows.entries()) {
    const time =
      i === 14 ? to : `2198-06-07T08:09:10.${String(123000 + (i === 3 ? 2 : i)).padStart(6, "0")}Z`;
    await t.sql`insert into audit_log(id,ts,actor,action,target,decision,meta) values(${ids[i]!},${time},${row.actor},${row.action},${row.target},${row.decision},${JSON.stringify(row.meta)}::jsonb)`;
  }
  app = buildApp({
    db: t.db,
    authToken: token,
    providerFactory: { languageModel: models, embeddingModel: models },
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
    if (t) await t.sql`delete from audit_log where id in ${t.sql(ids)}`;
  } finally {
    await t?.close();
  }
  expect(models).not.toHaveBeenCalled();
});
it("published query parameters execute over HTTP with a nonexistent project filter instead of membership404", async () => {
  const q = new URLSearchParams();
  for (const parameter of doc.paths[path]!.get!.parameters as {
    in: string;
    name: string;
    example?: unknown;
    schema: unknown;
  }[]) {
    if (parameter.in === "query" && parameter.example !== undefined) {
      validate(parameter.schema, parameter.example);
      q.set(parameter.name, String(parameter.example));
    }
  }
  expect(q.get("from")).toBeTruthy();
  expect(q.get("to")).toBeTruthy();
  q.set("project_id", uuidv7());
  const { body } = await request(200, q.toString());
  expect(body.items).toEqual([]);
  expect(body.limit).toBe(2);
  expect(body.next_after).toBeNull();
});
it("all known event families retain safe metadata while corrupt/unknown/oversized rows become opaque positions", async () => {
  const insert = vi.spyOn(t.db, "insert");
  try {
    const { body: r } = await request(200);
    expect(r).toMatchObject({ from, to, limit: 50, next_after: null });
    expect(r.items.map((x) => x.id)).toEqual(ids.slice(0, 14));
    expect(r.items.slice(0, 8).every((x) => !x.metadata_omitted)).toBe(true);
    expect(r.items[13]!.metadata_omitted).toBe(false);
    expect(r.items[0]).toMatchObject({
      actor: "server",
      action: "provider.create",
      meta: { version: 1, protocol: "openai-compatible", slots: ["chat"] },
    });
    expect(r.items[4]).toMatchObject({
      action: "flags.update",
      target: "server",
      meta: { revision: 1 },
    });
    expect(r.items[6]).toMatchObject({
      actor: "gate",
      action: "redact",
      meta: { pattern: "github_pat", count: 2 },
    });
    expect(r.items[7]).toMatchObject({
      actor: "cli",
      meta: { event_id: ids[7], client_reported: true, version: 1 },
    });
    for (const row of r.items.slice(8, 13))
      expect(row).toEqual({
        id: row.id,
        ts: row.ts,
        actor: null,
        action: null,
        target: null,
        decision: null,
        meta: null,
        metadata_omitted: true,
      });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(logs.join("")).not.toContain(secret);
    expect(
      (
        await t.sql`select octet_length(meta::text)::int as bytes from audit_log where id=${ids[10]!}`
      )[0]!.bytes,
    ).toBeGreaterThan(65536);
    expect(insert).not.toHaveBeenCalled();
    const validPage = ajv.compile({ $ref: "audit#/components/schemas/AuditLogPage" });
    const wrongCount = structuredClone(r);
    wrongCount.items[6]!.meta!.count = 0;
    expect(validPage(wrongCount)).toBe(false);
    const leaked = structuredClone(r);
    leaked.items[8]!.meta = { secret };
    expect(validPage(leaked)).toBe(false);
  } finally {
    insert.mockRestore();
  }
});
it("keyset pages preserve microseconds and timestamp ties, including opaque cursor rows", async () => {
  const seen: string[] = [];
  let after: string | undefined;
  for (let i = 0; i < 5; i++) {
    const { body: r } = await request(200, bounds({ limit: "3", ...(after ? { after } : {}) }));
    seen.push(...r.items.map((x) => x.id));
    if (r.next_after === null) {
      expect(i).toBe(4);
      break;
    }
    after = r.next_after;
  }
  expect(seen).toEqual(ids.slice(0, 14));
  expect(new Set(seen).size).toBe(14);
  const { body: r } = await request(200, bounds({ after: ids[8]!, limit: "2" }));
  expect(r.items.map((x) => x.id)).toEqual(ids.slice(9, 11));
  expect(r.items.every((x) => x.metadata_omitted)).toBe(true);
  expect(r.next_after).toBe(ids[10]);
  const empty = await request(200, bounds({ after: ids[13]! }));
  expect(empty.body.items).toEqual([]);
  expect(empty.body.next_after).toBeNull();
});
it("filters apply to stored fields before projection; project_id is metadata matching, not project existence", async () => {
  const { body: r } = await request(200, bounds({ project_id: p.toUpperCase() }));
  expect(r.items.length).toBeGreaterThan(0);
  expect(r.items.map((x) => x.id)).not.toContain(ids[0]);
  expect(r.items.map((x) => x.id)).not.toContain(ids[4]);
  expect(r.items.map((x) => x.id)).not.toContain(ids[13]);
  expect((await request(200, bounds({ actor: "gate" }))).body.items.map((x) => x.id)).toEqual([
    ids[6],
  ]);
  expect(
    (await request(200, bounds({ action: "flags.update", target: "server" }))).body.items.map(
      (x) => x.id,
    ),
  ).toEqual([ids[4]]);
  expect(
    (await request(200, bounds({ target: `sha256:${"b".repeat(64)}` }))).body.items.map(
      (x) => x.id,
    ),
  ).toEqual([ids[7], ids[9], ids[12]]);
  expect(
    (
      await request(200, bounds({ target: p.toUpperCase(), action: "provider.update" }))
    ).body.items.map((x) => x.id),
  ).toEqual([ids[1]]);
});
it("cursor UUID must exist inside the current filter/window and cannot recover excluded history", async () => {
  await request(404, bounds({ after: ids[14]! }));
  await request(404, bounds({ after: uuidv7() }));
  await request(404, bounds({ after: ids[0]!, actor: "gate" }));
  await request(404, bounds({ after: ids[13]!, project_id: p }));
});
it("default bounds resolve now minus30 days and offset timestamps retain the same selection", async () => {
  const now = Date.now();
  const { body: r } = await request(200, "limit=1");
  expect(Date.parse(r.to)).toBeGreaterThanOrEqual(now);
  expect(Date.parse(r.to)).toBeLessThanOrEqual(Date.now());
  expect(Date.parse(r.to) - Date.parse(r.from)).toBe(30 * 86400000);
  const a = await request(200),
    b = await request(
      200,
      bounds({ from: "2198-06-07T16:09:10.123+08:00", to: "2198-06-07T16:09:10.124+08:00" }),
    );
  expect(b.body).toEqual(a.body);
});
it.each([
  "unknown=1",
  "limit=201",
  "limit=0",
  "limit=1e2",
  "limit=",
  "limit=-1",
  "limit=1.5",
  "limit=1&limit=2",
  "actor=anonymous",
  "action=future.unknown",
  "target=private-name",
  "project_id=bad",
  "after=bad",
  bounds({ from: "2026-02-30T00:00:00Z" }),
  bounds({ from: "2198-06-07T08:09:10.1234Z" }),
  bounds({ from: to }),
  bounds({ from: "2190-01-01T00:00:00Z" }),
])("invalid query returns structured400: %s", async (query) => {
  const { body } = await request<{ errors: unknown[] }>(400, query);
  expect(body.errors.length).toBeGreaterThan(0);
});
it("authentication precedes invalid query and database operations", async () => {
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
    await request(401, "invalid=1", false, origin);
    expect(reads).toBe(0);
  } finally {
    await denied.close();
  }
});
it("database errors remain fixed500 and HTTP429 blocks subsequent database access", async () => {
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
    rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } },
    logStream: {
      write: (s) => {
        localLogs.push(s);
      },
    },
  });
  const origin = await failed.listen({ host: "127.0.0.1", port: 0 });
  try {
    const { body } = await request<{ detail: string }>(500, bounds(), true, origin);
    expect(body.detail).toBe("服务器内部错误");
    const before = reads;
    const r = await request(429, bounds(), true, origin);
    expect(r.response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(reads).toBe(before);
    expect(localLogs.join("")).not.toContain(secret);
  } finally {
    await failed.close();
  }
});
it("without DB configuration the audit route remains absent404", async () => {
  const bare = buildApp({ authToken: token, logStream: { write: () => {} } });
  const origin = await bare.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request(404, bounds(), true, origin);
  } finally {
    await bare.close();
  }
});
