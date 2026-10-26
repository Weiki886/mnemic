import { expect, it } from "vitest";
import { buildApp } from "../src/app.js";
const secret = "sk-debugsecret012345678901234567890";
it("opaque custom headers, secret-looking paths and request ids cannot enter access logs", async () => {
  let logs = "";
  const app = buildApp({
    auth: false,
    logStream: {
      write: (value) => {
        logs += value;
      },
    },
  });
  app.get("/debug-probe/:key", async () => ({ ok: true }));
  try {
    const res = await app.inject({
      url: `/debug-probe/${secret}?api_key=${secret}`,
      headers: {
        "x-request-id": secret,
        "x-custom-credential": "OPAQUE-CREDENTIAL-NOT-A-PATTERN",
        authorization: `Bearer ${secret}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).not.toBe(secret);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain("OPAQUE-CREDENTIAL-NOT-A-PATTERN");
    expect(logs).toContain("[REDACTED]");
  } finally {
    await app.close();
  }
});
it("unhandled exceptions do not serialize provider response, credentials, stack or request bodies", async () => {
  let logs = "";
  const app = buildApp({
    auth: false,
    logStream: {
      write: (value) => {
        logs += value;
      },
    },
  });
  app.get("/debug-failure", async () => {
    const error = Object.assign(new Error(secret), {
      response: { headers: { authorization: "OPAQUE-CREDENTIAL" } },
      requestBodyValues: { prompt: "PRIVATE-BODY" },
    });
    throw error;
  });
  try {
    expect((await app.inject({ url: "/debug-failure" })).statusCode).toBe(500);
    expect(logs).toContain("unhandled error");
    for (const value of [
      secret,
      "OPAQUE-CREDENTIAL",
      "PRIVATE-BODY",
      "requestBodyValues",
      '"stack"',
    ])
      expect(logs).not.toContain(value);
  } finally {
    await app.close();
  }
});
