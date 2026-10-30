import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  ids: string[] = [];
const token = "audit-read-offline-token-0000000000",
  headers = { authorization: `Bearer ${token}` };
const from = "2040-01-01T00:00:00.000Z",
  to = "2040-01-02T00:00:00.000Z",
  project = uuidv7(),
  other = uuidv7();
const query = (more: Record<string, string | number> = {}) =>
  `/v1/audit-log?${new URLSearchParams({ from, to, ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, String(v)])) })}`;
beforeAll(async () => {
  t = await setupTestDb();
  app = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
}, 180000);
beforeEach(async () => {
  if (ids.length) await t.sql`delete from audit_log where id=any(${ids}::uuid[])`;
  ids = [];
});
afterAll(async () => {
  await app?.close();
  if (t) {
    if (ids.length) await t.sql`delete from audit_log where id=any(${ids}::uuid[])`;
    await t.close();
  }
});
async function seed(over: Record<string, unknown> = {}) {
  const id = uuidv7();
  ids.push(id);
  const row = {
    actor: "server",
    action: "belief.delete",
    target: uuidv7(),
    decision: "updated",
    meta: { version: 1, project_id: project, before: "active", after: "deleted" },
    ts: "2040-01-01T00:00:00.000001Z",
    ...over,
  };
  await t.sql`insert into audit_log(id,ts,actor,action,target,decision,meta) values(${id},${row.ts as string}::timestamptz,${row.actor as string},${row.action as string},${row.target as string},${row.decision as string},${JSON.stringify(row.meta)}::jsonb)`;
  return id;
}
it("authenticated operator can query known events with safe metadata and no-store", async () => {
  const target = uuidv7(),
    id = await seed({ target });
  const r = await app.inject({
    url: query({ actor: "server", action: "belief.delete", target, project_id: project }),
    headers,
  });
  expect(r.statusCode).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.json()).toMatchObject({
    from,
    to,
    limit: 50,
    next_after: null,
    items: [
      {
        id,
        actor: "server",
        action: "belief.delete",
        target,
        decision: "updated",
        metadata_omitted: false,
        meta: { version: 1, project_id: project, before: "active", after: "deleted" },
      },
    ],
  });
  expect(r.json().items[0].ts).toMatch(/^2040-01-01T00:00:00\.000001Z$/);
});
it("cursor ordering preserves PG microseconds and visits every tied timestamp once", async () => {
  const a = await seed(),
    b = await seed(),
    c = await seed({ ts: "2040-01-01T00:00:00.000002Z" });
  const expected = [a, b].sort().concat(c),
    seen: string[] = [];
  let after: string | undefined;
  for (let n = 0; n < 3; n++) {
    const r = await app.inject({ url: query({ limit: 1, ...(after ? { after } : {}) }), headers });
    expect(r.statusCode).toBe(200);
    seen.push(r.json().items[0].id);
    after = r.json().next_after;
  }
  expect(seen).toEqual(expected);
  expect(after).toBeNull();
});
it("filters and exclusive end are enforced and a cursor from another selection is 404", async () => {
  const id = await seed();
  await seed({ meta: { version: 1, project_id: other, before: "active", after: "deleted" } });
  await seed({ ts: to });
  const r = await app.inject({ url: query({ project_id: project }), headers });
  expect(r.json().items.map((r: { id: string }) => r.id)).toEqual([id]);
  const wrong = await app.inject({ url: query({ project_id: other, after: id }), headers });
  expect(wrong.statusCode).toBe(404);
});
it("unknown or malformed rows cannot leak arbitrary metadata or opaque core strings", async () => {
  await seed({
    actor: "sk-private-actor",
    action: "unknown.secret",
    target: "sk-private-target",
    decision: "sk-private-decision",
    meta: { secret: "sk-private-metadata" },
  });
  await seed({
    meta: {
      version: 1,
      project_id: project,
      before: "active",
      after: "deleted",
      secret: "sk-private-extra",
    },
  });
  await seed({ meta: { secret: "sk-private-large" + "x".repeat(70000) } });
  const r = await app.inject({ url: query(), headers });
  expect(r.statusCode).toBe(200);
  expect(r.json().items).toHaveLength(3);
  expect(r.body).not.toContain("sk-private");
  for (const row of r.json().items)
    expect(row).toMatchObject({
      metadata_omitted: true,
      actor: null,
      action: null,
      target: null,
      decision: null,
      meta: null,
    });
});
it("existing flags and redaction events retain their validated historical fields", async () => {
  await seed({
    action: "flags.update",
    target: "server",
    meta: {
      schema_version: 1,
      previous_revision: 0,
      revision: 1,
      before: DEFAULT_FEATURE_FLAGS,
      after: { ...DEFAULT_FEATURE_FLAGS, memory_gate: false },
    },
  });
  await seed({
    actor: "gate",
    action: "redact",
    target: "candidate.value",
    decision: "redacted",
    meta: { pattern: "github_pat" },
  });
  const r = await app.inject({ url: query(), headers });
  expect(r.statusCode).toBe(200);
  expect(r.json().items.every((r: { metadata_omitted: boolean }) => !r.metadata_omitted)).toBe(
    true,
  );
  expect(r.json().items[1].meta).toEqual({ pattern: "github_pat" });
});
it.each([
  { limit: 0 },
  { limit: 201 },
  { limit: "1.5" },
  { limit: "" },
  { actor: "root" },
  { action: "unknown" },
  { project_id: "not-uuid" },
  { target: "arbitrary-secret" },
  { after: "bad" },
  { from: "nope" },
  { to: from },
  { to: "2042-01-01T00:00:00Z" },
  { unexpected: "x" },
])("invalid query %j is 400 with structural errors", async (extra) => {
  const r = await app.inject({ url: query(extra as Record<string, string | number>), headers });
  expect(r.statusCode).toBe(400);
  expect(r.json()).toMatchObject({ code: "VALIDATION_FAILED", errors: expect.any(Array) });
  expect(r.headers["cache-control"]).toBe("no-store");
});
it("authentication precedes both query validation and any DB access", async () => {
  let reads = 0;
  const a = buildApp({
    authToken: token,
    db: new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error("private-db");
        },
      },
    ) as TestDb["db"],
    logStream: { write: () => {} },
  });
  try {
    const r = await a.inject({ url: "/v1/audit-log?limit=bad" });
    expect(r.statusCode).toBe(401);
    expect(reads).toBe(0);
  } finally {
    await a.close();
  }
});
it("safe 500 does not reveal audit database exceptions", async () => {
  let logs = "";
  const a = buildApp({
    authToken: token,
    db: {
      execute: async () => {
        throw Error("sk-private-database");
      },
    } as unknown as TestDb["db"],
    logStream: {
      write: (s) => {
        logs += s;
      },
    },
  });
  try {
    const r = await a.inject({ url: query(), headers });
    expect(r.statusCode).toBe(500);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body + logs).not.toContain("sk-private-database");
  } finally {
    await a.close();
  }
});
it("real TCP exposes authenticated query and rejects unknown query fields", async () => {
  const a = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
  try {
    const base = await a.listen({ host: "127.0.0.1", port: 0 });
    const r = await fetch(base + query(), { headers });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ items: [], next_after: null });
    expect((await fetch(base + query({ extra: "x" }), { headers })).status).toBe(400);
  } finally {
    await a.close();
  }
});
it("client-reported approvals retain provenance and tampered envelope fields become opaque", async () => {
  const id = uuidv7(),
    event = {
      event_id: id,
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
  ids.push(id);
  const meta = { ...event, client_reported: true, version: 1 };
  await t.sql`insert into audit_log(id,ts,actor,action,target,decision,meta) values(${id},'2040-01-01T00:00:00Z'::timestamptz,'cli','approval.file.create',${"sha256:" + event.target_hash},'allow',${JSON.stringify(meta)}::jsonb)`;
  let r = await app.inject({ url: query(), headers });
  expect(r.statusCode).toBe(200);
  expect(r.json().items[0]).toMatchObject({
    metadata_omitted: false,
    actor: "cli",
    meta: { ...meta },
  });
  await t.sql`update audit_log set decision='deny' where id=${id}`;
  r = await app.inject({ url: query(), headers });
  expect(r.json().items[0]).toMatchObject({ metadata_omitted: true, meta: null });
});
it("the audit time/id index can be recreated idempotently without rewriting history", async () => {
  const id = await seed();
  await t.sql`create index if not exists audit_log_time_id_idx on audit_log(ts,id)`;
  await t.sql`create index if not exists audit_log_time_id_idx on audit_log(ts,id)`;
  const rows =
    await t.sql`select indexdef from pg_indexes where schemaname='public' and indexname='audit_log_time_id_idx'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.indexdef).toContain("(ts, id)");
  expect(await t.sql`select id from audit_log where id=${id}`).toHaveLength(1);
});
