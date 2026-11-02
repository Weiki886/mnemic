import { expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { requestOversizeHeaders } from "./fixtures/oversize-request.js";
it("real TCP rejects an oversized declared length before uploading bytes, preserving the 413 response", async () => {
  const app = buildApp({ auth: false, logStream: { write: () => {} } });
  let requests = 0,
    bytes = 0,
    declared = "",
    expectation = "";
  app.addHook("onRequest", async (request) => {
    requests++;
    declared = String(request.headers["content-length"]);
    expectation = String(request.headers.expect);
    request.raw.on("data", (chunk) => {
      bytes += chunk.length;
    });
  });
  const handler = vi.fn(() => ({ unexpected: true }));
  app.post("/large", handler);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const r = await requestOversizeHeaders(
      url + "/large",
      { "content-type": "application/json" },
      1048577,
    );
    expect(r.status).toBe(413);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(await r.json()).toMatchObject({ status: 413, code: "VALIDATION_FAILED" });
    expect(requests).toBe(1);
    expect(bytes).toBe(0);
    expect(declared).toBe("1048577");
    expect(expectation).toBe("100-continue");
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it("the same server limit rejects a complete oversized JSON body through deterministic injection", async () => {
  const app = buildApp({ auth: false, logStream: { write: () => {} } }),
    handler = vi.fn(() => ({ unexpected: true }));
  app.post("/large", handler);
  try {
    const r = await app.inject({
      method: "POST",
      url: "/large",
      payload: { query: "a".repeat(1048576) },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ status: 413, code: "VALIDATION_FAILED" });
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
