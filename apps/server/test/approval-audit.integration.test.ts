import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb, app: ReturnType<typeof buildApp>, project: string;
const ids: string[] = [],
  token = "approval-audit-test-token-".repeat(2);
const headers = { authorization: `Bearer ${token}` };
beforeAll(async () => {
  t = await setupTestDb();
  app = buildApp({ db: t.db, authToken: token });
}, 180_000);
beforeEach(async () => {
  project = randomUUID();
  ids.push(project);
  await t.sql`insert into projects (id,name) values (${project},'approval audit test')`;
});
afterAll(async () => {
  await app.close();
  for (const id of ids) {
    await t.sql`delete from audit_log where meta->>'project_id'=${id}`;
    await t.sql`delete from projects where id=${id}`;
  }
  await t.close();
});
const event = () => ({
  event_id: randomUUID(),
  request_id: randomUUID(),
  project_id: project,
  session_id: randomUUID(),
  mode: "confirm",
  operation: "file.create",
  decision: "allow",
  reason: "confirmed",
  scope: "once",
  root_hash: "a".repeat(64),
  target_hash: "b".repeat(64),
  target_basis: "canonical",
});
const post = (body: Record<string, unknown>, id = project) =>
  app.inject({ method: "POST", url: `/projects/${id}/approvals`, headers, payload: body });
const get = (id = project, query = "") =>
  app.inject({ method: "GET", url: `/projects/${id}/approvals${query}`, headers });
it("stores actor/action/target/decision/meta in existing audit_log, never plaintext payload", async () => {
  const payload = event(),
    res = await post(payload);
  expect(res.statusCode).toBe(201);
  expect(res.json().event).toEqual(payload);
  const [row] = await t.sql`select * from audit_log where id=${payload.event_id}`;
  expect(row).toMatchObject({
    actor: "cli",
    action: "approval.file.create",
    target: `sha256:${payload.target_hash}`,
    decision: "allow",
    meta: { ...payload, client_reported: true, version: 1 },
  });
  expect(res.json().recorded_at).toBe(new Date(row!.ts).toISOString());
  expect((await get()).json().items[0].event).toEqual(payload);
  expect(res.headers["cache-control"]).toBe("no-store");
});
it("identical event IDs are idempotent; different content conflicts without overwriting", async () => {
  const payload = event(),
    a = await post(payload),
    b = await post(payload);
  expect(a.statusCode).toBe(201);
  expect(b.statusCode).toBe(200);
  expect(b.json()).toEqual(a.json());
  const conflict = await post({ ...payload, decision: "deny", reason: "denied", scope: undefined });
  expect(conflict.statusCode).toBe(409);
  const rows = await t.sql`select * from audit_log where id=${payload.event_id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.decision).toBe("allow");
});
it("query and body cannot cross project scopes", async () => {
  const payload = event();
  await post(payload);
  const other = randomUUID();
  ids.push(other);
  await t.sql`insert into projects (id,name) values (${other},'other audit scope')`;
  expect((await get(other)).json().items).toEqual([]);
  expect((await post(payload, other)).statusCode).toBe(404);
  expect((await get()).json().items).toHaveLength(1);
});
it("auth is required before validation or database access", async () => {
  for (const method of ["GET", "POST"] as const) {
    const res = await app.inject({
      method,
      url: "/projects/not-a-uuid/approvals",
      ...(method === "POST" ? { payload: event() } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  }
});
it("rejects UUID, paging and sensitive extra fields with structured 400s", async () => {
  for (const res of [
    await get("bad-id"),
    await get(project, "?limit=201"),
    await get(project, "?offset="),
    await post({ ...event(), command: "sk-SECRET-do-not-store", target: "/private/key" }),
  ]) {
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.length).toBeGreaterThan(0);
  }
  expect((await get()).json().items).toEqual([]);
});
it("unknown projects return scoped 404s", async () => {
  const unknown = randomUUID();
  expect((await get(unknown)).statusCode).toBe(404);
  expect((await post({ ...event(), project_id: unknown }, unknown)).statusCode).toBe(404);
});
it("pages in stable order and excludes non-approval platform audit records", async () => {
  for (let i = 0; i < 3; i++) expect((await post(event())).statusCode).toBe(201);
  await t.sql`insert into audit_log(id,actor,action,decision,meta) values (${randomUUID()},'gate','secret.redacted','redacted',${JSON.stringify({ project_id: project })}::jsonb)`;
  const full = (await get()).json(),
    first = (await get(project, "?limit=2&offset=0")).json(),
    last = (await get(project, "?limit=2&offset=2")).json();
  expect(full.items).toHaveLength(3);
  expect([...first.items, ...last.items]).toEqual(full.items);
  expect(last).toMatchObject({ limit: 2, offset: 2 });
});
