import { expect, it } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildApp } from "../src/app.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
const token = "flags-api-offline-token-0000000000";
const tripwire = () => {
  let reads = 0;
  return {
    db: new Proxy({} as PostgresJsDatabase, {
      get() {
        reads++;
        throw Error("DB must stay unused");
      },
    }),
    count: () => reads,
  };
};
it.each(["GET", "PUT"] as const)(
  "%s authenticates before parsing body or accessing configuration",
  async (method) => {
    const db = tripwire(),
      app = buildApp({ db: db.db, authToken: token, logStream: { write: () => {} } });
    try {
      const r = await app.inject({
        method,
        url: "/v1/config/flags",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        ...(method === "PUT" ? { payload: "{malformed" } : {}),
      });
      expect(r.statusCode).toBe(401);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(db.count()).toBe(0);
    } finally {
      await app.close();
    }
  },
);
it.each([
  {
    expected_revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS, memory_gate: "PRIVATE_INVALID_BOOLEAN" },
  },
  { expected_revision: 0, flags: { memory_gate: false } },
  { expected_revision: 0, flags: { ...DEFAULT_FEATURE_FLAGS }, actor: "spoofed" },
  { expected_revision: -1, flags: { ...DEFAULT_FEATURE_FLAGS } },
  { expected_revision: Number.MAX_SAFE_INTEGER + 1, flags: { ...DEFAULT_FEATURE_FLAGS } },
])("invalid PUT %j is rejected before database access with field errors", async (payload) => {
  const db = tripwire(),
    app = buildApp({ db: db.db, authToken: token, logStream: { write: () => {} } });
  try {
    const r = await app.inject({
      method: "PUT",
      url: "/v1/config/flags",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors.length).toBeGreaterThan(0);
    expect(r.body).not.toContain("PRIVATE_INVALID_BOOLEAN");
    expect(db.count()).toBe(0);
    expect(r.headers["cache-control"]).toBe("no-store");
  } finally {
    await app.close();
  }
});
it("trusted PUT preflight is transport-only and never authorizes business mutation", async () => {
  const db = tripwire(),
    app = buildApp({
      db: db.db,
      authToken: token,
      corsOrigin: "https://web.example",
      logStream: { write: () => {} },
    });
  try {
    const r = await app.inject({
      method: "OPTIONS",
      url: "/v1/config/flags",
      headers: {
        origin: "https://web.example",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-methods"]).toContain("PUT");
    expect(db.count()).toBe(0);
    const denied = await app.inject({
      method: "PUT",
      url: "/v1/config/flags",
      headers: { origin: "https://web.example" },
      payload: { expected_revision: 0, flags: DEFAULT_FEATURE_FLAGS },
    });
    expect(denied.statusCode).toBe(401);
    expect(db.count()).toBe(0);
  } finally {
    await app.close();
  }
});
it("configuration DB failures use safe 500 without raw exceptions in logs or response", async () => {
  const secret = "sk-" + "S".repeat(30);
  let logs = "";
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      throw Error(secret);
    },
  });
  const app = buildApp({
    db,
    authToken: token,
    logStream: {
      write: (chunk) => {
        logs += chunk;
      },
    },
  });
  try {
    const r = await app.inject({
      url: "/v1/config/flags",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().code).toBe("INTERNAL_ERROR");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body + logs).not.toContain(secret);
  } finally {
    await app.close();
  }
});
it("all unsupported fields are rejected together before DB access", async () => {
  const db = tripwire(),
    app = buildApp({ db: db.db, authToken: token, logStream: { write: () => {} } });
  try {
    const r = await app.inject({
      method: "PUT",
      url: "/v1/config/flags",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        expected_revision: 0,
        flags: {
          ...DEFAULT_FEATURE_FLAGS,
          retrieval_entity: true,
          retrieval_time: true,
          decay: true,
          reranker: true,
          read_time_resolution: true,
        },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toHaveLength(5);
    expect(db.count()).toBe(0);
  } finally {
    await app.close();
  }
});
it.each(["GET", "PUT"] as const)("%s query overrides fail before DB access", async (method) => {
  const db = tripwire(),
    app = buildApp({ db: db.db, authToken: token, logStream: { write: () => {} } });
  try {
    const r = await app.inject({
      method,
      url: "/v1/config/flags?flags=false",
      headers: { authorization: `Bearer ${token}` },
      ...(method === "PUT"
        ? { payload: { expected_revision: 0, flags: DEFAULT_FEATURE_FLAGS } }
        : {}),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors.length).toBeGreaterThan(0);
    expect(db.count()).toBe(0);
  } finally {
    await app.close();
  }
});
