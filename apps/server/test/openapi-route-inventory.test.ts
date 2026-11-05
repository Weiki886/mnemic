import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { FastifyServerOptions } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
const seen = vi.hoisted(() => ({ routes: [] as { method: string; url: string }[] }));
// Observe public route registrations at the real Fastify boundary, not source text or a second route list.
vi.mock("fastify", async (importOriginal) => {
  const original = await importOriginal<typeof import("fastify")>();
  return {
    ...original,
    default: (options?: FastifyServerOptions) => {
      const app = original.default(options);
      app.addHook("onRoute", (route) => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method])
          seen.routes.push({ method, url: route.url });
      });
      return app;
    },
  };
});
import { buildApp } from "../src/app.js";
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;
const methods = new Set(["get", "head", "post", "put", "patch", "delete", "options", "trace"]);
const documented = () =>
  new Set(
    Object.entries(doc.paths).flatMap(([url, item]) =>
      Object.keys(item!)
        .filter((method) => methods.has(method))
        .map((method) => `${method.toUpperCase()} ${url}`),
    ),
  );
const apps: ReturnType<typeof buildApp>[] = [];
let reads = 0;
const db = new Proxy({} as PostgresJsDatabase, {
  get() {
    reads++;
    throw Error("inventory cannot access DB");
  },
});
const models = vi.fn(() => {
  throw Error("inventory cannot construct models");
});
async function capture(deps: "full" | "database" | "none" = "full") {
  seen.routes = [];
  reads = 0;
  models.mockClear();
  const app = buildApp({
    authToken: "inventory-offline-token-00000000000",
    corsOrigin: "https://web.example.invalid",
    ...(deps === "none" ? {} : { db }),
    ...(deps === "full" ? { masterKey: TEST_MASTER_KEY } : {}),
    providerFactory: { languageModel: models, embeddingModel: models },
    logStream: { write: () => {} },
  });
  apps.push(app);
  await app.ready();
  expect(reads).toBe(0);
  expect(models).not.toHaveBeenCalled();
  return { app, routes: seen.routes.map((r) => ({ ...r })) };
}
function operations(routes: { method: string; url: string }[], contract = documented()) {
  const result = new Set<string>();
  for (const { method, url } of routes) {
    // CORS transport negotiation is not an application operation. No other OPTIONS is silently excluded.
    if (method === "OPTIONS" && (url === "*" || url === "/*")) continue;
    const path = url.replace(/:([^/]+)/g, "{$1}");
    // Fastify implicitly exposes HEAD for GET. Explicitly documented HEAD stays in the comparison.
    if (method === "HEAD" && contract.has(`GET ${path}`) && !contract.has(`HEAD ${path}`)) continue;
    result.add(`${method} ${path}`);
  }
  return result;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it("the checked contract covers every configured runtime HTTP operation and registers no invented operation", async () => {
  const { app, routes } = await capture();
  expect(operations(routes)).toEqual(documented());
  for (const op of documented()) {
    const [method, ...rest] = op.split(" ");
    expect(
      app.hasRoute({ method: method as "GET", url: rest.join(" ").replace(/\{([^}]+)\}/g, ":$1") }),
      op,
    ).toBe(true);
  }
  expect(routes.filter((r) => r.method === "OPTIONS")).toHaveLength(1);
});
it("inventory detects both an undocumented runtime operation and a missing documented operation", async () => {
  const { routes } = await capture();
  expect(operations([...routes, { method: "POST", url: "/undocumented" }])).not.toEqual(
    documented(),
  );
  expect(
    operations(routes.filter((r) => !(r.method === "POST" && r.url === "/providers"))),
  ).not.toEqual(documented());
});
it.each(["database", "none"] as const)(
  "%s dependencies expose a documented subset without implying readiness",
  async (deps) => {
    const { app, routes } = await capture(deps);
    for (const op of operations(routes)) expect(documented().has(op), op).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/docs" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/providers" })).toBe(false);
    expect(app.hasRoute({ method: "GET", url: "/v1/config" })).toBe(deps === "database");
  },
);
