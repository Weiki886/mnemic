import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildApp, type BuildAppOptions } from "../src/app.js";

const TOKEN = "rate-limit-fixture-" + "a".repeat(40);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const apps: ReturnType<typeof buildApp>[] = [];
function fixture(rateLimit: BuildAppOptions["rateLimit"], extra: BuildAppOptions = {}) {
  const app = buildApp({ authToken: TOKEN, rateLimit, ...extra });
  apps.push(app);
  app.post("/work", async () => ({ ok: true }));
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const wide = { capacity: 100, refillPerSecond: 0.01 };
const narrow = { capacity: 1, refillPerSecond: 0.01 };

describe("#23 HTTP rate admission", () => {
  it("limits unauthenticated IPs before malformed body parsing or database access", async () => {
    let reads = 0;
    const db = new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error("DB must not be read");
        },
      },
    ) as PostgresJsDatabase;
    const app = fixture({ ip: narrow, token: wide }, { db });
    const request = () =>
      app.inject({
        method: "PUT",
        url: "/v1/config/flags",
        headers: { "content-type": "application/json" },
        payload: "{broken",
      });
    expect((await request()).statusCode).toBe(401);
    const denied = await request();
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["content-type"]).toContain("application/problem+json");
    expect(denied.headers["cache-control"]).toBe("no-store");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
    expect(denied.json()).toMatchObject({
      status: 429,
      title: "Too Many Requests",
      code: "RATE_LIMITED",
      requestId: denied.headers["x-request-id"],
    });
    expect(reads).toBe(0);
  });

  it("shares the valid-token budget across IPs; denied requests never execute handlers", async () => {
    const app = fixture({ ip: wide, token: narrow });
    let calls = 0;
    app.post("/effect", async () => {
      calls++;
      return { ok: true };
    });
    const first = await app.inject({
      method: "POST",
      url: "/effect",
      headers: AUTH,
      remoteAddress: "10.0.0.1",
    });
    const denied = await app.inject({
      method: "POST",
      url: "/effect",
      headers: AUTH,
      remoteAddress: "10.0.0.2",
    });
    expect(first.statusCode).toBe(200);
    expect(denied.statusCode).toBe(429);
    expect(calls).toBe(1);
  });

  it("invalid tokens cannot spend the authenticated identity budget", async () => {
    const app = fixture({ ip: wide, token: narrow });
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/work",
            headers: { authorization: `Bearer wrong-${i}` },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/work", headers: AUTH })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "POST", url: "/work", headers: AUTH })).statusCode).toBe(
      429,
    );
  });

  it("uses socket IP, ignoring forged forwarding headers, while other IPs remain independent", async () => {
    const app = fixture({ ip: narrow, token: wide });
    const req = (remoteAddress: string, spoof: string) =>
      app.inject({
        method: "POST",
        url: "/work",
        headers: {
          ...AUTH,
          "x-forwarded-for": spoof,
          "x-real-ip": spoof,
          forwarded: `for=${spoof}`,
        },
        remoteAddress,
      });
    expect((await req("10.0.0.1", "1.1.1.1")).statusCode).toBe(200);
    expect((await req("10.0.0.1", "2.2.2.2")).statusCode).toBe(429);
    expect((await req("10.0.0.2", "1.1.1.1")).statusCode).toBe(200);
  });

  it("health GET/HEAD and trusted preflight remain available after exhaustion; no prefix exemption", async () => {
    const app = fixture({ ip: narrow, token: narrow }, { corsOrigin: "https://web.example" });
    expect((await app.inject({ method: "POST", url: "/work", headers: AUTH })).statusCode).toBe(
      200,
    );
    for (const method of ["GET", "HEAD"] as const)
      expect((await app.inject({ method, url: "/health?probe=1" })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "OPTIONS",
          url: "/work",
          headers: {
            origin: "https://web.example",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,content-type",
          },
        })
      ).statusCode,
    ).toBe(204);
    for (const url of ["/health/more", "/%68ealth", "/nope"])
      expect((await app.inject({ url, headers: AUTH })).statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: "/health", headers: AUTH })).statusCode).toBe(
      429,
    );
    expect(
      (
        await app.inject({
          method: "OPTIONS",
          url: "/work",
          headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
        })
      ).statusCode,
    ).toBe(429);
  });

  it("early IP rejection exposes 429 to the trusted CORS source only and leaks no credentials", async () => {
    const logs: string[] = [];
    const app = fixture(
      { ip: narrow, token: wide },
      { corsOrigin: "https://web.example", logStream: { write: (s) => logs.push(s) } },
    );
    await app.inject({ method: "POST", url: "/work", headers: AUTH });
    for (const origin of ["https://web.example", "https://evil.example"]) {
      const res = await app.inject({
        method: "POST",
        url: "/work?token=" + TOKEN,
        headers: { ...AUTH, origin },
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers["access-control-allow-origin"]).toBe(
        origin === "https://web.example" ? origin : undefined,
      );
      expect(res.body).not.toContain(TOKEN);
    }
    expect(logs.join("")).not.toContain(TOKEN);
  });

  it("lets trusted browser code read the retry delay on early token rejection", async () => {
    const app = fixture({ ip: wide, token: narrow }, { corsOrigin: "https://web.example" });
    await app.inject({ method: "POST", url: "/work", headers: AUTH });
    const res = await app.inject({
      method: "POST",
      url: "/work",
      headers: { ...AUTH, origin: "https://web.example" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["access-control-expose-headers"]).toContain("retry-after");
    expect(res.headers["access-control-expose-headers"]).toContain("x-request-id");
  });

  it("token exhaustion precedes body parsing and DB access even on authenticated requests", async () => {
    let reads = 0;
    const db = new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error("DB not allowed");
        },
      },
    ) as PostgresJsDatabase;
    const app = fixture({ ip: wide, token: narrow }, { db });
    expect((await app.inject({ method: "POST", url: "/work", headers: AUTH })).statusCode).toBe(
      200,
    );
    const res = await app.inject({
      method: "PUT",
      url: "/v1/config/flags",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{broken",
    });
    expect(res.statusCode).toBe(429);
    expect(reads).toBe(0);
  });

  it("has bounded IP state and fails closed rather than evicting an active client", async () => {
    const app = fixture({ ip: narrow, token: wide, maxIps: 1 });
    expect(
      (await app.inject({ url: "/work", remoteAddress: "10.0.0.1", headers: AUTH })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: "/work", remoteAddress: "10.0.0.2", headers: AUTH })).statusCode,
    ).toBe(429);
    expect(
      (await app.inject({ url: "/work", remoteAddress: "10.0.0.1", headers: AUTH })).statusCode,
    ).toBe(429);
  });

  it("captures settings before caller mutation and isolates independent app instances", async () => {
    const settings = { ip: { ...wide }, token: { ...narrow } };
    const one = fixture(settings);
    settings.token.capacity = 100;
    const two = fixture({ ip: wide, token: narrow });
    expect((await one.inject({ method: "POST", url: "/work", headers: AUTH })).statusCode).toBe(
      200,
    );
    expect((await one.inject({ method: "POST", url: "/work", headers: AUTH })).statusCode).toBe(
      429,
    );
    expect((await two.inject({ method: "POST", url: "/work", headers: AUTH })).statusCode).toBe(
      200,
    );
  });

  it("uses RATE_LIMITED for other handlers throwing statusCode 429", async () => {
    const app = fixture({ ip: wide, token: wide });
    app.get("/downstream", async () => {
      throw Object.assign(Error("too fast"), { statusCode: 429 });
    });
    const res = await app.inject({ url: "/downstream", headers: AUTH });
    expect(res.json()).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      title: "Too Many Requests",
    });
  });

  it("enables default limits even when no override is supplied", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const app = fixture(undefined);
      const results = await Promise.all(
        Array.from({ length: 125 }, () =>
          app.inject({ method: "POST", url: "/work", headers: AUTH }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(120);
      expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
    } finally {
      clock.mockRestore();
    }
  });

  it("enforces a real TCP burst atomically without invoking a database/model", async () => {
    const app = fixture({ ip: wide, token: { capacity: 3, refillPerSecond: 0.01 } });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const res = await fetch(url + "/work", { method: "POST", headers: AUTH });
        const json = await res.json();
        return { status: res.status, json, retry: res.headers.get("retry-after") };
      }),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(9);
    for (const denied of results.filter((r) => r.status === 429)) {
      expect(denied.json).toMatchObject({ code: "RATE_LIMITED" });
      expect(Number(denied.retry)).toBeGreaterThan(0);
    }
  });

  it.each([
    { maxIps: 0 },
    { ip: { capacity: 1.5, refillPerSecond: 1 } },
    { token: { capacity: 1, refillPerSecond: 0 } },
    { unexpected: true },
    null,
    false,
  ])("rejects malformed operator configuration before serving (%#)", (rateLimit) => {
    expect(() => buildApp({ authToken: TOKEN, rateLimit } as BuildAppOptions)).toThrow();
  });
});
