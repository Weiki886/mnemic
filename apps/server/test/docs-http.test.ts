import { afterEach, expect, it, vi } from "vitest";
import { Ajv } from "ajv";
import { readFile } from "node:fs/promises";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
const token = "docs-test-offline-token-000000000000";
const apps: ReturnType<typeof buildApp>[] = [];
function make(options: BuildAppOptions = {}) {
  const app = buildApp({ authToken: token, logStream: { write: () => {} }, ...options });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it("serves exact static contract and full offline reference over real TCP with no Token, DB or model access", async () => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error("no data access");
    },
  });
  const model = vi.fn(() => {
    throw Error("no model access");
  });
  const app = make({
    db,
    masterKey: TEST_MASTER_KEY,
    providerFactory: { languageModel: model, embeddingModel: model },
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const page = await fetch(base + "/docs?ignored=true");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain("API 契约参考");
  expect(html).toContain("cancelChatGeneration");
  expect(html).toContain("Schema 索引");
  const artifact = await fetch(base + "/docs/openapi.json");
  expect(artifact.status).toBe(200);
  expect(artifact.headers.get("content-type")).toContain("application/json");
  const raw = await artifact.text();
  expect(raw).toBe(await readFile(new URL("../../../docs/openapi.json", import.meta.url), "utf8"));
  const contract = JSON.parse(raw);
  const ajv = new Ajv({ strict: false, validateFormats: false });
  ajv.addSchema({ components: contract.components }, "online-docs");
  const validate = ajv.compile({ $ref: "online-docs#/components/schemas/OpenApiArtifact" });
  expect(validate(contract), JSON.stringify(validate.errors)).toBe(true);
  expect(
    ajv.compile(contract.paths["/docs"].get.responses["200"].content["text/html"].schema)(html),
  ).toBe(true);
  for (const path of ["/docs", "/docs/openapi.json"]) {
    const head = await fetch(base + path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(head.headers.get("x-request-id")).toBeTruthy();
  }
  expect(reads).toBe(0);
  expect(model).not.toHaveBeenCalled();
});
it("HTML has a restrictive offline CSP, no active controls/external assets, and never reflects request data", async () => {
  const app = make();
  const secret = 'hostile-query-"><script>alert(1)</script>';
  const page = await app.inject({
    url: "/docs?token=" + encodeURIComponent(secret),
    headers: { host: "attacker.example", authorization: "Bearer arbitrary-bad-token" },
  });
  expect(page.statusCode).toBe(200);
  expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(page.headers["content-security-policy"]).toContain("form-action 'none'");
  expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(page.headers["x-content-type-options"]).toBe("nosniff");
  expect(page.headers["referrer-policy"]).toBe("no-referrer");
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.body).not.toContain(secret);
  expect(page.body).not.toContain("attacker.example");
  expect(page.body).not.toContain("arbitrary-bad-token");
  expect(page.body).not.toMatch(/<script|<form|<input|<iframe|(?:src|href)="https?:/i);
});
it.each([
  "/docs/",
  "/docs/openapi.json/",
  "/docs/private",
  "/docs/openapi.json/other",
  "/docsx",
  "/%64ocs",
  "/docs%2fopenapi.json",
  "/DOCS",
])("public docs exemption does not include %s", async (url) => {
  const app = make();
  for (const method of ["GET", "HEAD"] as const)
    expect((await app.inject({ method, url })).statusCode).toBe(401);
});
it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
  "%s cannot use docs exemption to bypass Bearer or parse a body",
  async (method) => {
    const r = await make().inject({
      method,
      url: "/docs",
      headers: { "content-type": "application/json" },
      payload: "{broken",
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("UNAUTHORIZED");
  },
);
it("anonymous docs still spend IP budget", async () => {
  const app = make({ rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } } });
  expect((await app.inject({ url: "/docs" })).statusCode).toBe(200);
  const denied = await app.inject({ url: "/docs/openapi.json" });
  expect(denied.statusCode).toBe(429);
  expect(denied.json().code).toBe("RATE_LIMITED");
  expect(denied.headers["retry-after"]).toMatch(/^[1-9]\d*$/);
  const head = await app.inject({ method: "HEAD", url: "/docs/openapi.json" });
  expect(head.statusCode).toBe(429);
  expect(head.body).toBe("");
  expect(head.headers["retry-after"]).toMatch(/^[1-9]\d*$/);
});
it("anonymous docs do not spend valid operator token budget, while actual business calls still do", async () => {
  const app = make({
    rateLimit: {
      ip: { capacity: 100, refillPerSecond: 1 },
      token: { capacity: 1, refillPerSecond: 0.001 },
    },
  });
  for (const url of ["/docs", "/docs/openapi.json"])
    expect((await app.inject({ url })).statusCode).toBe(200);
  const denied = await app.inject({ url: "/v1/doctor" });
  expect(denied.statusCode).toBe(401);
  const headers = { authorization: `Bearer ${token}` };
  expect((await app.inject({ url: "/v1/doctor", headers })).statusCode).toBe(200);
  expect((await app.inject({ url: "/v1/doctor", headers })).statusCode).toBe(429);
});
it("health remains exempt even when the docs IP budget is exhausted", async () => {
  const app = make({ rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } } });
  await app.inject({ url: "/docs" });
  expect((await app.inject({ url: "/docs" })).statusCode).toBe(429);
  expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
});
