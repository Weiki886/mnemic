import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { Ajv } from "ajv";
import { readFile } from "node:fs/promises";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
let t: TestDb, app: ReturnType<typeof buildApp>, base: string;
const token = "offline-provider-reranker-token-00000000",
  key = "offline-provider-reranker-key-00000000",
  ids: string[] = [];
const headers = { authorization: `Bearer ${token}` },
  config = { endpoint_path: "/score", timeout_ms: 5000 };
const body = () => ({
  name: `score-${uuidv7()}`,
  base_url: "https://offline.invalid/v1",
  api_key: key,
  config,
});
async function create() {
  const r = await app.inject({
    method: "POST",
    url: "/v1/providers/reranker",
    headers,
    payload: body(),
  });
  expect(r.statusCode).toBe(201);
  const v = r.json();
  ids.push(v.provider_id);
  return v;
}
async function audits(id: string) {
  return t.sql`select * from audit_log where target=${id} and action like 'provider.reranker.%' order by ts,id`;
}
beforeAll(async () => {
  t = await setupTestDb();
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    logStream: { write: () => {} },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  await app?.close();
  if (t) {
    for (const id of ids) {
      await t.sql`delete from audit_log where target=${id}`;
      await t.sql`delete from provider_configs where id=${id}`;
    }
    await t.close();
  }
});
it("real HTTP creates encrypted Score-only config against committed OpenAPI without changing legacy DTOs", async () => {
  const payload = body(),
    r = await fetch(base + "/v1/providers/reranker", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  expect(r.status).toBe(201);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const view = (await r.json()) as { provider_id: string };
  ids.push(view.provider_id);
  const doc = JSON.parse(
    await readFile(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
  ) as OpenApiDocument;
  const ajv = new Ajv({ strict: false, formats: { uuid: true, "date-time": true } });
  ajv.addSchema({ components: doc.components }, "reranker");
  const schema =
    doc.paths["/v1/providers/reranker"]!.post!.responses!["201"]!.content["application/json"]!
      .schema;
  const validate = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"reranker#/components/')),
  );
  expect(validate(view), JSON.stringify(validate.errors)).toBe(true);
  expect(view).toMatchObject({ model_id: "Qwen/Qwen3-Reranker-0.6B", revision: 0, config });
  expect(JSON.stringify(view)).not.toContain(key);
  const [row] = await t.sql`select * from provider_configs where id=${view.provider_id}`;
  expect(row?.models).toEqual({});
  expect(row?.api_key_encrypted).not.toContain(key);
  const current = await app.inject({ url: `/v1/providers/${view.provider_id}/reranker`, headers });
  expect(current.statusCode).toBe(200);
  expect(current.json()).toEqual(view);
  const legacy = await app.inject({ url: "/providers", headers });
  expect(legacy.statusCode).toBe(200);
  expect(legacy.json().find((x: { id: string }) => x.id === view.provider_id)).not.toHaveProperty(
    "reranker_config",
  );
  const events = await audits(view.provider_id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actor: "server",
    action: "provider.reranker.create",
    decision: "created",
    meta: { version: 1, revision: 0, configured: true },
  });
  expect(JSON.stringify(events)).not.toContain(key);
  expect(JSON.stringify(events)).not.toContain(payload.name);
});
it("legacy Providers receive disabled defaults, independent capabilities do not change their three slots", async () => {
  const p = await createProvider(t.db, TEST_MASTER_KEY, {
    name: `legacy-${uuidv7()}`,
    protocol: "openai-compatible",
    baseUrl: "https://offline.invalid/v1",
    apiKey: key,
    models: { chat: "offline-chat" },
  });
  ids.push(p.id);
  const r = await app.inject({ url: `/v1/providers/${p.id}/reranker`, headers });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ revision: 0, config: null });
  const update = await app.inject({
    method: "PUT",
    url: `/v1/providers/${p.id}/reranker`,
    headers,
    payload: { expected_revision: 0, config },
  });
  expect(update.statusCode).toBe(200);
  const safe = await app.inject({ url: "/v1/config", headers });
  expect(safe.json().providers.find((x: { id: string }) => x.id === p.id).models).toEqual({
    chat: "offline-chat",
  });
});
it("eight same-revision writes produce one update and audit; no-op does not advance revision", async () => {
  const p = await create(),
    url = `/v1/providers/${p.provider_id}/reranker`;
  const replies = await Promise.all(
    Array.from({ length: 8 }, () =>
      app.inject({ method: "PUT", url, headers, payload: { expected_revision: 0, config: null } }),
    ),
  );
  expect(replies.filter((x) => x.statusCode === 200)).toHaveLength(1);
  expect(replies.filter((x) => x.statusCode === 409)).toHaveLength(7);
  expect(await audits(p.provider_id)).toHaveLength(2);
  const noop = await app.inject({
    method: "PUT",
    url,
    headers,
    payload: { expected_revision: 1, config: null },
  });
  expect(noop.json()).toMatchObject({ kind: "unchanged", revision: 1, config: null });
  expect(await audits(p.provider_id)).toHaveLength(2);
});
it("audit failure rolls back configuration and hides DB exceptions", async () => {
  const p = await create(),
    constraint = `test_rerank_audit_${p.provider_id.replaceAll("-", "")}`;
  await t.sql.unsafe(
    `alter table audit_log add constraint ${constraint} check (target <> '${p.provider_id}') not valid`,
  );
  try {
    const r = await app.inject({
      method: "PUT",
      url: `/v1/providers/${p.provider_id}/reranker`,
      headers,
      payload: { expected_revision: 0, config: null },
    });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain(constraint);
    expect(
      (await app.inject({ url: `/v1/providers/${p.provider_id}/reranker`, headers })).json(),
    ).toMatchObject({ revision: 0, config });
  } finally {
    await t.sql.unsafe(`alter table audit_log drop constraint ${constraint}`);
  }
});
it.each(["GET", "PUT"] as const)(
  "%s authentication precedes JSON and DB access",
  async (method) => {
    let reads = 0;
    const db = new Proxy(t.db, {
      get() {
        reads++;
        throw Error("private DB");
      },
    });
    const isolated = buildApp({
      db,
      masterKey: TEST_MASTER_KEY,
      authToken: token,
      logStream: { write: () => {} },
    });
    try {
      const r = await isolated.inject({
        method,
        url: `/v1/providers/${uuidv7()}/reranker`,
        ...(method === "PUT"
          ? { payload: "{broken", headers: { "content-type": "application/json" } }
          : {}),
      });
      expect(r.statusCode).toBe(401);
      expect(reads).toBe(0);
    } finally {
      await isolated.close();
    }
  },
);
it.each(["GET", "PUT"] as const)(
  "%s validates UUIDs and rejects missing Providers",
  async (method) => {
    for (const [id, status] of [
      ["bad", 400],
      [uuidv7(), 404],
    ] as const) {
      const r = await app.inject({
        method,
        url: `/v1/providers/${id}/reranker`,
        headers,
        ...(method === "PUT" ? { payload: { expected_revision: 0, config: null } } : {}),
      });
      expect(r.statusCode).toBe(status);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  },
);
it.each([
  { api_key: key, expected_revision: 0, config: null },
  { expected_revision: -1, config: null },
  { expected_revision: 0, config: { ...config, model: "other" } },
  { expected_revision: 0, config: { ...config, endpoint_path: "//evil/score" } },
])("strict PUT rejects invalid/credential-bearing payload %j", async (payload) => {
  const p = await create();
  const r = await app.inject({
    method: "PUT",
    url: `/v1/providers/${p.provider_id}/reranker`,
    headers,
    payload,
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().errors.length).toBeGreaterThan(0);
  expect(r.body).not.toContain(key);
  expect(await audits(p.provider_id)).toHaveLength(1);
});
it.each(["GET", "PUT"] as const)("%s rejects unknown query fields", async (method) => {
  const p = await create();
  const r = await app.inject({
    method,
    url: `/v1/providers/${p.provider_id}/reranker?extra=x`,
    headers,
    ...(method === "PUT" ? { payload: { expected_revision: 0, config: null } } : {}),
  });
  expect(r.statusCode).toBe(400);
});
it("transport errors are 400/413/415 problem+json without caching", async () => {
  const p = await create(),
    url = `/v1/providers/${p.provider_id}/reranker`;
  const wrong = await app.inject({
    method: "PUT",
    url,
    headers: { ...headers, "content-type": "text/xml" },
    payload: "<xml/>",
  });
  expect(wrong.statusCode).toBe(415);
  const malformed = await app.inject({
    method: "PUT",
    url,
    headers: { ...headers, "content-type": "application/json" },
    payload: "{broken",
  });
  expect(malformed.statusCode).toBe(400);
  const oversized = await app.inject({
    method: "PUT",
    url,
    headers: { ...headers, "content-type": "application/json", "content-length": "2000000" },
    payload: "{}",
  });
  expect(oversized.statusCode).toBe(413);
  for (const r of [wrong, malformed, oversized]) {
    expect(r.headers["content-type"]).toContain("application/problem+json");
    expect(r.headers["cache-control"]).toBe("no-store");
  }
});
it("duplicate score-only registrations return 409", async () => {
  const payload = body(),
    a = await app.inject({ method: "POST", url: "/v1/providers/reranker", headers, payload });
  expect(a.statusCode).toBe(201);
  ids.push(a.json().provider_id);
  expect(
    (await app.inject({ method: "POST", url: "/v1/providers/reranker", headers, payload }))
      .statusCode,
  ).toBe(409);
});
it("revision exhaustion rejects updates but leaves unchanged requests valid", async () => {
  const p = await create();
  await t.sql`update provider_configs set reranker_config=${JSON.stringify({ revision: Number.MAX_SAFE_INTEGER, config })}::jsonb where id=${p.provider_id}`;
  const url = `/v1/providers/${p.provider_id}/reranker`;
  expect(
    (
      await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { expected_revision: Number.MAX_SAFE_INTEGER, config: null },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { expected_revision: Number.MAX_SAFE_INTEGER, config },
      })
    ).json().kind,
  ).toBe("unchanged");
});
it.each([
  null,
  [],
  { revision: 0 },
  { revision: -1, config: null },
  { revision: 0, config: { ...config, api_key: key } },
  { revision: 0, config: { ...config, timeout_ms: 1.1 } },
  { revision: 0, config: { ...config, endpoint_path: "//evil/score" } },
  { revision: Number.MAX_SAFE_INTEGER + 1, config: null },
])("DB rejects invalid persisted state %j", async (value) => {
  const p = await create();
  await expect(
    t.sql`update provider_configs set reranker_config=${JSON.stringify(value)}::jsonb where id=${p.provider_id}`,
  ).rejects.toMatchObject({ code: "23514" });
});
it("migration replays without resetting configured state", async () => {
  const p = await create(),
    source = await readFile(
      new URL("../drizzle/0019_provider_reranker_config.sql", import.meta.url),
      "utf8",
    );
  for (let n = 0; n < 2; n++)
    await t.sql.begin(async (tx) => {
      for (const s of source.split("--> statement-breakpoint")) if (s.trim()) await tx.unsafe(s);
    });
  expect(
    (await app.inject({ url: `/v1/providers/${p.provider_id}/reranker`, headers })).json(),
  ).toMatchObject({ revision: 0, config });
});
it("resolver decrypts only internally, derives same-origin URL and never fetches", async () => {
  const p = await create(),
    spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("must not fetch"));
  try {
    const { resolveProviderRerankerConfig } = await import("../src/providers/reranker.js");
    expect(await resolveProviderRerankerConfig(t.db, TEST_MASTER_KEY, p.provider_id)).toMatchObject(
      {
        providerId: p.provider_id,
        revision: 0,
        config: { endpoint: "https://offline.invalid/score", apiKey: key, timeoutMs: 5000 },
      },
    );
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it("unsafe current endpoints fail closed; disabled capability returns null", async () => {
  const p = await create();
  const { resolveProviderRerankerConfig } = await import("../src/providers/reranker.js");
  await t.sql`update provider_configs set base_url='https://user:private@offline.invalid/v1' where id=${p.provider_id}`;
  await expect(resolveProviderRerankerConfig(t.db, TEST_MASTER_KEY, p.provider_id)).rejects.toThrow(
    /^RERANKER_CONFIG_UNAVAILABLE$/,
  );
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/v1/providers/${p.provider_id}/reranker`,
        headers,
        payload: { expected_revision: 0, config: null },
      })
    ).statusCode,
  ).toBe(200);
  expect(await resolveProviderRerankerConfig(t.db, TEST_MASTER_KEY, p.provider_id)).toBeNull();
});

it("GET/PUT examples are executable over real HTTP and validate against their own committed response schemas", async () => {
  const p = await create(),
    doc = JSON.parse(
      await readFile(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
    ) as OpenApiDocument;
  const ajv = new Ajv({ strict: false, formats: { uuid: true, "date-time": true } });
  ajv.addSchema({ components: doc.components }, "cap");
  const path = "/v1/providers/{id}/reranker",
    url = `${base}/v1/providers/${p.provider_id}/reranker`;
  const { ProviderRerankerUpdateSchema } = await import("@mnemic/shared/management");
  const request = doc.paths[path]!.put!.requestBody as {
    content: { "application/json": { example: unknown } };
  };
  const payload = ProviderRerankerUpdateSchema.parse(request.content["application/json"].example);
  for (const method of ["get", "put"] as const) {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: { ...headers, "content-type": "application/json" },
      ...(method === "put" ? { body: JSON.stringify(payload) } : {}),
    });
    expect(response.status).toBe(200);
    const value = await response.json();
    const schema = doc.paths[path]![method]!.responses!["200"]!.content["application/json"]!.schema;
    const validate = ajv.compile(
      JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"cap#/components/')),
    );
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  }
  const audit = await app.inject({ url: `/v1/audit-log?target=${p.provider_id}`, headers });
  expect(audit.statusCode).toBe(200);
  expect(audit.json().items.every((x: { metadata_omitted: boolean }) => !x.metadata_omitted)).toBe(
    true,
  );
  expect(JSON.stringify(audit.json())).not.toContain(key);
  expect(JSON.stringify(audit.json())).not.toContain("endpoint_path");
});
it("metadata is readable without decryption; corrupted credentials never escape the internal resolver", async () => {
  const p = await create(),
    { resolveProviderRerankerConfig } = await import("../src/providers/reranker.js");
  await t.sql`update provider_configs set api_key_encrypted='corrupt-private-ciphertext' where id=${p.provider_id}`;
  const r = await app.inject({ url: `/v1/providers/${p.provider_id}/reranker`, headers });
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain("corrupt-private");
  await expect(resolveProviderRerankerConfig(t.db, TEST_MASTER_KEY, p.provider_id)).rejects.toThrow(
    /^RERANKER_CONFIG_UNAVAILABLE$/,
  );
});
it("repository input is copied before the transaction can yield", async () => {
  const p = await create(),
    { updateProviderRerankerConfig } = await import("../src/providers/reranker.js");
  const value = { expected_revision: 0, config: { endpoint_path: "/v1/score", timeout_ms: 1000 } };
  const pending = updateProviderRerankerConfig(t.db, p.provider_id, value);
  value.expected_revision = 10;
  value.config.timeout_ms = 3;
  expect(await pending).toMatchObject({
    kind: "updated",
    revision: 1,
    config: { endpoint_path: "/v1/score", timeout_ms: 1000 },
  });
});
it("audit failure during creation leaves no Provider behind", async () => {
  const payload = body(),
    name = `test_score_create_${uuidv7().replaceAll("-", "")}`;
  await t.sql.unsafe(
    `alter table audit_log add constraint ${name} check (action <> 'provider.reranker.create') not valid`,
  );
  try {
    const r = await app.inject({ method: "POST", url: "/v1/providers/reranker", headers, payload });
    expect(r.statusCode).toBe(500);
    expect(await t.sql`select id from provider_configs where name=${payload.name}`).toHaveLength(0);
  } finally {
    await t.sql.unsafe(`alter table audit_log drop constraint ${name}`);
  }
});
it.each([
  "http://external.invalid/v1",
  "ftp://offline.invalid/v1",
  "https://user:secret@offline.invalid/v1",
  "https://offline.invalid/v1?key=secret",
])("unsafe Provider base %s is rejected without probing", async (base_url) => {
  const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("must not fetch"));
  try {
    const r = await app.inject({
      method: "POST",
      url: "/v1/providers/reranker",
      headers,
      payload: { ...body(), base_url },
    });
    expect(r.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it("POST authentication precedes malformed JSON and credential-bearing registration", async () => {
  let reads = 0;
  const db = new Proxy(t.db, {
    get() {
      reads++;
      throw Error("private DB");
    },
  });
  const isolated = buildApp({
    db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    logStream: { write: () => {} },
  });
  try {
    for (const payload of ["{broken", JSON.stringify(body())]) {
      const response = await isolated.inject({
        method: "POST",
        url: "/v1/providers/reranker",
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode).toBe(401);
      expect(reads).toBe(0);
      expect(response.body).not.toContain(key);
    }
  } finally {
    await isolated.close();
  }
});
