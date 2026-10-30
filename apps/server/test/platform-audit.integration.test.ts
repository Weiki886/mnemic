import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb, app: ReturnType<typeof buildApp>, project: string, belief: string;
const token = "platform-audit-offline-token-000000",
  headers = { authorization: `Bearer ${token}` };
beforeAll(async () => {
  t = await setupTestDb();
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    logStream: { write: () => {} },
  });
}, 180000);
beforeEach(async () => {
  project = uuidv7();
  belief = uuidv7();
  await t.sql`insert into projects(id,name) values(${project},'private-project-name')`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute) values(${belief},${project},'sk-private-subject','private-body')`;
});
afterAll(async () => {
  await app?.close();
  await t?.close();
});
const mutation = (kind: string) =>
  app.inject({ method: "POST", url: `/projects/${project}/beliefs/${belief}/${kind}`, headers });
const audits = () => t.sql`select * from audit_log where target=${belief} order by ts,id`;
it("delete/restore audit durable reference-only transitions and their actor/time/result", async () => {
  expect((await mutation("delete")).statusCode).toBe(200);
  expect((await mutation("restore")).statusCode).toBe(200);
  const rows = await audits();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    actor: "server",
    action: "belief.delete",
    target: belief,
    decision: "updated",
    meta: { version: 1, project_id: project, before: "active", after: "deleted" },
  });
  expect(rows[1]).toMatchObject({
    actor: "server",
    action: "belief.restore",
    target: belief,
    decision: "updated",
    meta: { version: 1, project_id: project, before: "deleted", after: "active" },
  });
  expect(rows[0]!.ts).toBeTruthy();
  expect(JSON.stringify(rows)).not.toMatch(/sk-private|private-body/);
});
it("eight concurrent deletes commit exactly one update and one audit", async () => {
  const r = await Promise.all(Array.from({ length: 8 }, () => mutation("delete")));
  expect(r.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(r.filter((r) => r.statusCode === 409)).toHaveLength(7);
  expect(await audits()).toHaveLength(1);
});
it("cross-project/missing/conflicting/unauthenticated operations never fabricate audit success", async () => {
  const wrong = await app.inject({
    method: "POST",
    url: `/projects/${uuidv7()}/beliefs/${belief}/delete`,
    headers,
  });
  expect(wrong.statusCode).toBe(404);
  expect((await mutation("restore")).statusCode).toBe(409);
  expect(
    (await app.inject({ method: "POST", url: `/projects/${project}/beliefs/${belief}/delete` }))
      .statusCode,
  ).toBe(401);
  expect(await audits()).toEqual([]);
});
it.each(["delete", "restore"])(
  "audit failure rolls back %s and emits no successful debug trace",
  async (kind) => {
    if (kind === "restore") await t.sql`update beliefs set status='deleted' where id=${belief}`;
    const events: unknown[] = [];
    const { registerBeliefReadRoutes } = await import("../src/beliefs/read-routes.js");
    const a = buildApp({ authToken: token, logStream: { write: () => {} } });
    registerBeliefReadRoutes(a, t.db, (e) => events.push(e));
    await t.sql`alter table audit_log add constraint platform_test_reject check(action not in ('belief.delete','belief.restore')) not valid`;
    try {
      const r = await a.inject({
        method: "POST",
        url: `/projects/${project}/beliefs/${belief}/${kind}`,
        headers,
      });
      expect(r.statusCode).toBe(500);
      expect((await t.sql`select status from beliefs where id=${belief}`)[0]!.status).toBe(
        kind === "delete" ? "active" : "deleted",
      );
      expect(events).toEqual([]);
      expect(await audits()).toEqual([]);
    } finally {
      await t.sql`alter table audit_log drop constraint platform_test_reject`;
      await a.close();
    }
  },
);
const providerBody = () => ({
  name: `private-name-${uuidv7()}`,
  protocol: "openai-compatible",
  base_url: "https://private.example.invalid/v1",
  api_key: "sk-private-credential-with-secret",
  models: { chat: "private-model-name", embedding: "private-model-name" },
});
it("provider configuration creation is audited atomically without config strings or credentials", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/providers",
    headers,
    payload: providerBody(),
  });
  expect(r.statusCode).toBe(201);
  const rows = await t.sql`select * from audit_log where target=${r.json().id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor: "server",
    action: "provider.create",
    decision: "created",
    meta: { version: 1, protocol: "openai-compatible", slots: ["chat", "embedding"] },
  });
  expect(JSON.stringify(rows)).not.toMatch(
    /private-name|private\.example|private-model|sk-private|v1:/,
  );
});
it("provider audit failure prevents the configuration from being committed", async () => {
  const body = providerBody();
  await t.sql`alter table audit_log add constraint provider_test_reject check(action <> 'provider.create') not valid`;
  try {
    expect(
      (await app.inject({ method: "POST", url: "/providers", headers, payload: body })).statusCode,
    ).toBe(500);
    expect(await t.sql`select id from provider_configs where name=${body.name}`).toEqual([]);
  } finally {
    await t.sql`alter table audit_log drop constraint provider_test_reject`;
  }
});
it.each(["json", "csv"])(
  "usage %s export records prepared scope/count/format, not exported content",
  async (format) => {
    const r = await app.inject({
      url: `/projects/${project}/usage/export?format=${format}`,
      headers,
    });
    expect(r.statusCode).toBe(200);
    const rows =
      await t.sql`select * from audit_log where action='usage.export' and target=${project}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "server",
      decision: "prepared",
      meta: {
        version: 1,
        project_id: project,
        conversation_id: null,
        format,
        rows: 0,
        after: null,
        next_after: null,
      },
    });
    expect(rows[0]!.meta.from).toBeDefined();
    expect(rows[0]!.meta.to).toBeDefined();
    expect(JSON.stringify(rows)).not.toMatch(/provider_name|private-body|raw_text/);
  },
);
it("failed export audit prevents both JSON and CSV payload disclosure", async () => {
  await t.sql`alter table audit_log add constraint export_test_reject check(action <> 'usage.export') not valid`;
  try {
    for (const format of ["json", "csv"]) {
      const r = await app.inject({
        url: `/projects/${project}/usage/export?format=${format}`,
        headers,
      });
      expect(r.statusCode).toBe(500);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(r.headers["content-disposition"]).toBeUndefined();
    }
    expect(await t.sql`select * from audit_log where target=${project}`).toEqual([]);
  } finally {
    await t.sql`alter table audit_log drop constraint export_test_reject`;
  }
});
it("report queries and invalid export scope do not create export receipts", async () => {
  expect((await app.inject({ url: `/projects/${project}/usage`, headers })).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        url: `/projects/${project}/usage/export?conversation_id=${uuidv7()}`,
        headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ url: `/projects/${project}/usage/export?limit=0`, headers })).statusCode,
  ).toBe(400);
  expect(
    await t.sql`select * from audit_log where action='usage.export' and target=${project}`,
  ).toEqual([]);
});
it("paginated export audits exactly the prepared records/cursors and is queryable end to end", async () => {
  const rowIds = [uuidv7(), uuidv7(), uuidv7()];
  for (const id of rowIds)
    await t.sql`insert into model_usage(id,project_id,provider_name,model_id,slot,purpose,status,started_at,duration_ms) values(${id},${project},'sk-private-provider','private-model','chat','chat','success','2040-01-01T00:00:00Z'::timestamptz,1)`;
  const window = "from=2040-01-01T00:00:00Z&to=2040-01-02T00:00:00Z&limit=2";
  const first = await app.inject({ url: `/projects/${project}/usage/export?${window}`, headers });
  expect(first.statusCode).toBe(200);
  expect(first.json().records).toHaveLength(2);
  const after = first.json().next_after;
  expect(after).toBeTruthy();
  const last = await app.inject({
    url: `/projects/${project}/usage/export?${window}&after=${after}`,
    headers,
  });
  expect(last.json().records).toHaveLength(1);
  expect(last.json().next_after).toBeNull();
  const records =
    await t.sql`select meta from audit_log where action='usage.export' and target=${project} order by ts,id`;
  expect(records.map((r) => r.meta.rows)).toEqual([2, 1]);
  expect(records[0]!.meta.next_after).toBe(after);
  expect(records[1]!.meta.after).toBe(after);
  const read = await app.inject({
    url: `/v1/audit-log?action=usage.export&target=${project}`,
    headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().items).toHaveLength(2);
  expect(read.json().items.every((r: { metadata_omitted: boolean }) => !r.metadata_omitted)).toBe(
    true,
  );
  expect(read.body).not.toContain("sk-private-provider");
});
it("internal empty-slot provider compatibility is preserved while the public API still rejects it", async () => {
  const { createProvider } = await import("../src/providers/repository.js");
  const config = await createProvider(t.db, TEST_MASTER_KEY, {
    name: `empty-${uuidv7()}`,
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline-empty-key",
    models: {},
  });
  const rows = await t.sql`select meta from audit_log where target=${config.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.meta.slots).toEqual([]);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/providers",
        headers,
        payload: { ...providerBody(), models: {} },
      })
    ).statusCode,
  ).toBe(400);
});
it("provider PATCH records only changed field names, while identical updates are audit no-ops", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/providers",
    headers,
    payload: providerBody(),
  });
  const id = created.json().id;
  const payload = {
    name: `patched-private-${uuidv7()}`,
    models: { chat: "patched-private-model" },
  };
  for (let i = 0; i < 2; i++)
    expect(
      (await app.inject({ method: "PATCH", url: `/providers/${id}`, headers, payload })).statusCode,
    ).toBe(200);
  const rows = await t.sql`select * from audit_log where target=${id} and action='provider.update'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor: "server",
    decision: "updated",
    meta: {
      version: 1,
      changed_fields: ["name", "models.chat"],
      before_protocol: "openai-compatible",
      after_protocol: "openai-compatible",
    },
  });
  expect(JSON.stringify(rows)).not.toMatch(/patched-private|private-model|sk-private/);
  const read = await app.inject({
    url: `/v1/audit-log?action=provider.update&target=${id}`,
    headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().items[0].metadata_omitted).toBe(false);
});
it("provider PATCH audit failure rolls back the changed configuration", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/providers",
    headers,
    payload: providerBody(),
  });
  const id = created.json().id;
  const [before] =
    await t.sql`select name,models,api_key_encrypted from provider_configs where id=${id}`;
  await t.sql`alter table audit_log add constraint patch_test_reject check(action <> 'provider.update') not valid`;
  try {
    const r = await app.inject({
      method: "PATCH",
      url: `/providers/${id}`,
      headers,
      payload: { name: `should-roll-back-${uuidv7()}` },
    });
    expect(r.statusCode).toBe(500);
    expect(
      (await t.sql`select name,models,api_key_encrypted from provider_configs where id=${id}`)[0],
    ).toEqual(before);
    expect(
      await t.sql`select * from audit_log where target=${id} and action='provider.update'`,
    ).toEqual([]);
  } finally {
    await t.sql`alter table audit_log drop constraint patch_test_reject`;
  }
});
