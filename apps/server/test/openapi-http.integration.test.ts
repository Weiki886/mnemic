import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Ajv } from "ajv";
import type { createOpenApiDocument } from "../scripts/openapi.js";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { readFeatureFlags } from "../src/flags/repository.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  base: string,
  saved: Awaited<ReturnType<typeof readFeatureFlags>>;
const token = "openapi-contract-offline-token-000000",
  headers = { authorization: `Bearer ${token}` };
const factory = vi.fn(() => {
  throw Error("contract example must not invoke models");
});
const doc = JSON.parse(
    readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
  ) as ReturnType<typeof createOpenApiDocument>,
  ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema({ components: doc.components }, "mnemic");
function validate(schema: unknown, body: unknown) {
  const rewritten = JSON.parse(
    JSON.stringify(schema).replaceAll('"#/components/', '"mnemic#/components/'),
  );
  const v = ajv.compile(rewritten);
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
function responseSchema(method: "get" | "put", status: number) {
  const response = doc.paths["/v1/config/flags"]![method]!.responses[String(status)] as {
    content: Record<string, { schema: unknown }>;
  };
  return Object.values(response.content)[0]!.schema;
}
beforeAll(async () => {
  t = await setupTestDb();
  saved = await readFeatureFlags(t.db);
  await t.sql`update feature_flags set flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb,revision=0 where scope='server'`;
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    providerFactory: { languageModel: factory, embeddingModel: factory },
    logStream: { write: () => {} },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  await app?.close();
  if (t) {
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb,revision=${saved.revision} where scope='server'`;
    await t.close();
  }
});
it("documented health GET/HEAD examples run over TCP without credentials", async () => {
  const r = await fetch(base + "/health");
  expect(r.status).toBe(200);
  const op = doc.paths["/health"]!.get!;
  const response = op.responses["200"] as {
    content: Record<string, { schema: unknown; example: unknown }>;
  };
  const json = response.content["application/json"]!;
  const body = await r.json();
  expect(body).toEqual(json.example);
  validate(json.schema, body);
  const head = await fetch(base + "/health", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});
it("GET and the generated PUT request example validate against the artifact schemas", async () => {
  let r = await fetch(base + "/v1/config/flags", { headers });
  expect(r.status).toBe(200);
  validate(responseSchema("get", 200), await r.json());
  const op = doc.paths["/v1/config/flags"]!.put!,
    request = op.requestBody as { content: Record<string, { schema: unknown; example: unknown }> };
  const content = request.content["application/json"]!;
  validate(content.schema, content.example);
  r = await fetch(base + "/v1/config/flags", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(content.example),
  });
  expect(r.status).toBe(200);
  validate(responseSchema("put", 200), await r.json());
  r = await fetch(base + "/v1/config/flags", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(content.example),
  });
  expect(r.status).toBe(409);
  validate(responseSchema("put", 409), await r.json());
  expect(factory).not.toHaveBeenCalled();
});
it.each(["unauthorized", "unsupported", "media", "query"])(
  "%s errors conform to generated problem+json including canonical type",
  async (kind) => {
    const req = doc.paths["/v1/config/flags"]!.put!.requestBody as {
      content: Record<string, { example: Record<string, unknown> }>;
    };
    const example = req.content["application/json"]!.example;
    const r = await fetch(base + `/v1/config/flags${kind === "query" ? "?extra=x" : ""}`, {
      method: "PUT",
      headers: {
        ...(kind === "unauthorized" ? {} : headers),
        "content-type": kind === "media" ? "text/plain" : "application/json",
      },
      body:
        kind === "unauthorized"
          ? "{broken"
          : JSON.stringify(
              kind === "unsupported"
                ? { ...example, flags: { ...DEFAULT_FEATURE_FLAGS, reranker: true } }
                : example,
            ),
    });
    const status = { unauthorized: 401, unsupported: 400, media: 415, query: 400 }[kind];
    expect(r.status).toBe(status);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    const body = await r.json();
    validate(responseSchema("put", status!), body);
    expect(body).toMatchObject({ type: expect.stringMatching(/^https:\/\/mnemic.dev\/errors\//) });
    expect(factory).not.toHaveBeenCalled();
  },
);
it("rate-limit headers and body match the documented 429 response without database access", async () => {
  const a = buildApp({
    authToken: token,
    db: new Proxy(
      {},
      {
        get() {
          throw Error("no DB access allowed");
        },
      },
    ) as TestDb["db"],
    rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } },
    logStream: { write: () => {} },
  });
  try {
    await a.inject({ url: "/nope" });
    const r = await a.inject({ url: "/v1/config/flags", headers });
    expect(r.statusCode).toBe(429);
    validate(responseSchema("get", 429), r.json());
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(r.headers["x-request-id"]).toBeTruthy();
  } finally {
    await a.close();
  }
});
