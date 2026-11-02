import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import type { z } from "zod";
import type { LegacyProviderViewSchema } from "../src/contracts/providers.js";
import type { ServerConfig, ProjectStatus, ProviderConfig, ProblemDetails } from "@mnemic/shared";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
type Legacy = z.infer<typeof LegacyProviderViewSchema>;
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "date-time": /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/,
    uri: (value: string) => URL.canParse(value),
  },
});
ajv.addSchema({ components: doc.components }, "provider");
const project = uuidv7(),
  other = uuidv7(),
  conversation = uuidv7(),
  foreignConversation = uuidv7();
const token = "provider-contract-offline-token-000000",
  key = "private-offline-fixture-key-9876";
const primaryName = "primary-" + uuidv7(),
  collisionName = "collision-" + uuidv7();
let primary: string, t: TestDb, app: ReturnType<typeof buildApp>, base: string;
let savedRows: unknown[] = [];
const logs: string[] = [];
const sdk = vi.fn(() => {
  throw Error("configuration must not construct SDK or invoke models");
});
function validate(schema: unknown, body: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"provider#/components/')),
  );
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
async function request<T = unknown>(
  path: string,
  method: "get" | "post" | "patch",
  status: number,
  opts: {
    id?: string;
    project?: string;
    query?: string;
    body?: unknown;
    raw?: string;
    media?: string;
    auth?: boolean;
  } = {},
) {
  const r = await fetch(
    base +
      path.replace("{id}", opts.id ?? primary).replace("{projectId}", opts.project ?? project) +
      (opts.query ?? ""),
    {
      method: method.toUpperCase(),
      headers: {
        ...(opts.auth === false ? {} : { authorization: `Bearer ${token}` }),
        ...(opts.body !== undefined || opts.raw !== undefined
          ? { "content-type": opts.media ?? "application/json" }
          : {}),
      },
      ...(opts.body !== undefined
        ? { body: JSON.stringify(opts.body) }
        : opts.raw !== undefined
          ? { body: opts.raw }
          : {}),
    },
  );
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("content-type")).toContain(
    status < 400 ? "application/json" : "application/problem+json",
  );
  expect(r.headers.get("x-request-id")).toBeTruthy();
  const response = doc.paths[path]?.[method]?.responses[String(status)] as
    { content: Record<string, { schema: unknown }> } | undefined;
  expect(response, `undocumented ${method} ${path} ${status}`).toBeTruthy();
  validate(Object.values(response!.content)[0]!.schema, body);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(key);
  expect(serialized).not.toContain("apiKeyEncrypted");
  if (
    path === "/v1/config" ||
    path === "/projects/{projectId}/status" ||
    (method === "patch" && status === 200)
  )
    expect(r.headers.get("cache-control")).toBe("no-store");
  return body as T;
}
function example(path: string, method: "post" | "patch") {
  const rb = doc.paths[path]![method]!.requestBody as {
    content: Record<string, { schema: unknown; example: Record<string, unknown> }>;
  };
  const m = rb.content["application/json"]!;
  validate(m.schema, m.example);
  return m.example;
}
beforeAll(async () => {
  t = await setupTestDb();
  // Let PostgreSQL encode timestamps so restoring this global fixture preserves microseconds.
  savedRows = (await t.sql`select to_jsonb(p) as row from provider_configs p`).map((r) => r.row);
  await t.sql`delete from provider_configs`;
  primary = (
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: primaryName,
      protocol: "openai-compatible",
      baseUrl: "https://primary.invalid/v1",
      apiKey: key,
      models: { chat: "initial-chat", extraction: "initial-extract" },
    })
  ).id;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: collisionName,
    protocol: "anthropic",
    baseUrl: "https://collision.invalid",
    apiKey: key,
    models: { chat: "later-chat" },
  });
  await t.sql`insert into projects (id,name) values (${project},'provider-contract'),(${other},'foreign-project')`;
  await t.sql`insert into conversations (id,project_id) values (${conversation},${project}),(${foreignConversation},${other})`;
  for (const status of ["active", "deleted", "retracted"])
    await t.sql`insert into beliefs (id,project_id,subject,attribute,status) values (${uuidv7()},${project},${status},'x',${status})`;
  await t.sql`insert into beliefs (id,project_id,subject,attribute) values (${uuidv7()},${other},'foreign-private','x')`;
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    providerFactory: { languageModel: sdk, embeddingModel: sdk },
    logStream: { write: (chunk) => logs.push(chunk) },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  await app?.close();
  if (t) {
    try {
      await t.sql.begin(async (tx) => {
        await tx`delete from provider_configs`;
        if (savedRows.length)
          await tx`insert into provider_configs select * from jsonb_populate_recordset(null::provider_configs,${JSON.stringify(savedRows)}::jsonb)`;
      });
    } finally {
      await t.close();
    }
  }
  expect(sdk).not.toHaveBeenCalled();
  expect(logs.join("")).not.toContain(key);
  expect(logs.join("")).not.toContain("offline-example-key-1234");
});
it("published create and patch examples run with encrypted keys, distinct public views and atomic metadata-only audits", async () => {
  const createBody = example("/providers", "post");
  const created = await request<Legacy>("/providers", "post", 201, { body: createBody });
  expect(created).toMatchObject({
    name: "openapi-offline-example",
    apiKeyMasked: "••••1234",
    baseUrl: "https://example.invalid/v1",
  });
  expect(JSON.stringify(created)).not.toContain(createBody.api_key);
  const [stored] =
    await t.sql`select api_key_encrypted from provider_configs where id=${created.id}`;
  expect(stored!.api_key_encrypted).toMatch(/^v1:/);
  expect(stored!.api_key_encrypted).not.toContain(createBody.api_key);
  const list = await request<Legacy[]>("/providers", "get", 200, { query: "?ignored=yes" });
  expect(list.find((p) => p.id === created.id)).toEqual(created);
  const patchBody = example("/providers/{id}", "patch");
  const updated = await request<ProviderConfig>("/providers/{id}", "patch", 200, {
    id: created.id,
    body: patchBody,
  });
  expect(updated).toMatchObject({
    base_url: created.baseUrl,
    models: { chat: "offline-chat-updated", extraction: "offline-extract-updated" },
  });
  expect(updated).not.toHaveProperty("apiKeyMasked");
  const config = await request<ServerConfig>("/v1/config", "get", 200);
  expect(config.providers.find((p) => p.id === created.id)).toEqual(updated);
  expect(config.slots.chat).toMatchObject({ provider_id: primary });
  const audits =
    await t.sql`select action,decision,meta from audit_log where target=${created.id} order by ts,id`;
  expect(audits.map((a) => a.action)).toEqual(["provider.create", "provider.update"]);
  for (const forbidden of [
    createBody.api_key,
    createBody.name,
    createBody.base_url,
    "offline-chat-updated",
  ])
    expect(JSON.stringify(audits)).not.toContain(forbidden);
  await request("/providers", "post", 409, { body: createBody });
});
it("unchanged patch creates no audit and supplied strings are trimmed", async () => {
  const before = (await t.sql`select count(*)::int as n from audit_log where target=${primary}`)[0]!
    .n;
  await request("/providers/{id}", "patch", 200, { body: { name: primaryName } });
  expect(
    (await t.sql`select count(*)::int as n from audit_log where target=${primary}`)[0]!.n,
  ).toBe(before);
  expect(
    await request<ProviderConfig>("/providers/{id}", "patch", 200, {
      body: { models: { chat: "  trimmed-chat  " } },
    }),
  ).toMatchObject({ models: { chat: "trimmed-chat" } });
});
it("embedding Provider endpoint/protocol changes are rejected without model calls", async () => {
  const created = await request<Legacy>("/providers", "post", 201, {
    body: {
      ...example("/providers", "post"),
      name: "embedding-" + uuidv7(),
      models: { embedding: "offline-1024" },
    },
  });
  await request("/providers/{id}", "patch", 409, {
    id: created.id,
    body: { base_url: "https://replacement.invalid" },
  });
  await request("/providers/{id}", "patch", 409, {
    id: created.id,
    body: { protocol: "anthropic" },
  });
});
it("name collision is 409 and missing UUID is 404", async () => {
  await request("/providers/{id}", "patch", 409, { body: { name: collisionName } });
  await request("/providers/{id}", "patch", 404, { id: uuidv7(), body: { name: "missing" } });
});
it("audit failure rolls back patch and returns only the documented fixed 500", async () => {
  const [before] = await t.sql`select models from provider_configs where id=${primary}`;
  const constraint = "contract_provider_" + uuidv7().replaceAll("-", "");
  await t.sql.unsafe(
    `alter table audit_log add constraint ${constraint} check (action <> 'provider.update' or target <> '${primary}') not valid`,
  );
  try {
    const failed = await request<ProblemDetails>("/providers/{id}", "patch", 500, {
      body: { models: { chat: "rollback-only-model" } },
    });
    expect(JSON.stringify(failed)).not.toContain(constraint);
    expect(
      (await t.sql`select models from provider_configs where id=${primary}`)[0]!.models,
    ).toEqual(before!.models);
  } finally {
    await t.sql.unsafe(`alter table audit_log drop constraint ${constraint}`);
  }
});
it("status counts belong to the URL project while model slots remain global", async () => {
  const status = await request<ProjectStatus>("/projects/{projectId}/status", "get", 200, {
    query: `?conversation_id=${conversation}`,
  });
  expect(status.counts).toEqual({
    total: 3,
    active: 1,
    deleted: 1,
    retracted: 1,
    superseded: 0,
    expired: 0,
  });
  expect(status.slots.chat).toMatchObject({ provider_id: primary });
  await request("/projects/{projectId}/status", "get", 404, {
    query: `?conversation_id=${foreignConversation}`,
  });
});
it("safe snapshots need no key decryption while legacy masked reads fail closed on corrupt ciphertext", async () => {
  const [row] = await t.sql`select api_key_encrypted from provider_configs where id=${primary}`;
  await t.sql`update provider_configs set api_key_encrypted='corrupt-ciphertext-fixture' where id=${primary}`;
  try {
    await request("/v1/config", "get", 200);
    await request("/projects/{projectId}/status", "get", 200, {
      query: `?conversation_id=${conversation}`,
    });
    const failed = await request("/providers", "get", 500);
    expect(JSON.stringify(failed)).not.toContain("corrupt-ciphertext-fixture");
  } finally {
    await t.sql`update provider_configs set api_key_encrypted=${row!.api_key_encrypted} where id=${primary}`;
  }
});
it("safe config strips URL credentials but legacy endpoint retains raw metadata", async () => {
  const raw = "https://url-user:url-password@legacy.invalid/v1?token=url-query#url-fragment";
  const created = await request<Legacy>("/providers", "post", 201, {
    body: { ...example("/providers", "post"), name: "url-" + uuidv7(), base_url: raw },
  });
  expect(created.baseUrl).toBe(raw);
  const config = await request<ServerConfig>("/v1/config", "get", 200);
  expect(config.providers.find((p) => p.id === created.id)?.base_url).toBe(
    "https://legacy.invalid/v1",
  );
  for (const secret of ["url-user", "url-password", "url-query", "url-fragment"])
    expect(JSON.stringify(config)).not.toContain(secret);
});
it("invalid earliest metadata is reported rather than silently falling through to a later Provider", async () => {
  const id = uuidv7();
  await t.sql`insert into provider_configs (id,name,protocol,base_url,api_key_encrypted,models,created_at) select ${id},${"invalid-" + id},protocol,base_url,api_key_encrypted,'null'::jsonb,'2000-01-01' from provider_configs where id=${primary}`;
  try {
    const config = await request<ServerConfig>("/v1/config", "get", 200);
    expect(config.invalid_provider_ids).toContain(id);
    expect(config.providers.some((p) => p.id === id)).toBe(false);
    expect(config.slots.chat).toMatchObject({ provider_id: id, model: null, invalid: true });
    const legacy = await request<Legacy[]>("/providers", "get", 200);
    expect(legacy.find((p) => p.id === id)?.models).toBeNull();
  } finally {
    await t.sql`delete from provider_configs where id=${id}`;
  }
});
it.each([
  [
    "/providers",
    "post",
    {
      body: {
        ...{
          name: "bad",
          protocol: "openai-compatible",
          base_url: "https://example.invalid",
          api_key: "offline-12345678",
        },
        models: {},
      },
    },
  ],
  ["/providers/{id}", "patch", { id: "bad", body: { name: "x" } }],
  ["/providers/{id}", "patch", { body: {} }],
  ["/providers/{id}", "patch", { body: { api_key: "forbidden-key-change" } }],
  ["/providers/{id}", "patch", { body: { models: { embedding: "forbidden" } } }],
  ["/providers/{id}", "patch", { body: { base_url: "https://u:p@example.invalid?x=1" } }],
  ["/v1/config", "get", { query: "?extra=ignored-no-longer" }],
  ["/projects/{projectId}/status", "get", {}],
  ["/projects/{projectId}/status", "get", { query: `?conversation_id=${conversation}&extra=x` }],
] as const)("invalid %s input gives structured 400 before mutation", async (path, method, opts) => {
  const failed = await request<ProblemDetails>(path, method, 400, opts);
  expect(failed.errors?.length).toBeGreaterThan(0);
});
it("authentication precedes malformed provider JSON and invalid patch IDs", async () => {
  await request("/providers", "post", 401, { raw: "{broken", auth: false });
  await request("/providers/{id}", "patch", 401, { id: "bad", raw: "{broken", auth: false });
});
it.each([
  [415, "text/xml", "<provider/>"],
  [413, "application/json", JSON.stringify({ name: "x".repeat(1048576) })],
] as const)(
  "parser rejection %s uses the generated problem response",
  async (status, media, raw) => {
    await request("/providers", "post", status, { media, raw });
  },
);

it("safe config remains available without a master key while legacy credential views are unregistered", async () => {
  const service = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
  const url = await service.listen({ host: "127.0.0.1", port: 0 });
  try {
    const config = await fetch(url + "/v1/config", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(config.status).toBe(200);
    const response = doc.paths["/v1/config"]!.get!.responses["200"] as {
      content: Record<string, { schema: unknown }>;
    };
    validate(response.content["application/json"]!.schema, await config.json());
    for (const method of ["get", "post"] as const) {
      const r = await fetch(url + "/providers", {
        method: method.toUpperCase(),
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "post" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "post" ? { body: JSON.stringify(example("/providers", "post")) } : {}),
      });
      expect(r.status).toBe(404);
      const problem = doc.paths["/providers"]![method]!.responses["404"] as {
        content: Record<string, { schema: unknown }>;
      };
      validate(problem.content["application/problem+json"]!.schema, await r.json());
    }
  } finally {
    await service.close();
  }
});
