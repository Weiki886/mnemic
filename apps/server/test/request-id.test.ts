import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("请求 ID 贯穿", () => {
  it("响应携带 x-request-id；上游传入时透传同一值", async () => {
    const app = buildApp();

    const generated = await app.inject({ method: "GET", url: "/health" });
    const generatedId = generated.headers["x-request-id"];
    expect(typeof generatedId).toBe("string");
    expect((generatedId as string).length).toBeGreaterThan(0);

    const echoed = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "trace-abc-123" },
    });
    expect(echoed.headers["x-request-id"]).toBe("trace-abc-123");
    await app.close();
  });

  it("日志为结构化 JSON 且包含请求 ID", async () => {
    const lines: string[] = [];
    const app = buildApp({
      logStream: {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    });
    await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "trace-log-1" },
    });
    const entries = lines
      .flatMap((l) => l.split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(0);
    const withReqId = entries.filter((e) => e["reqId"] === "trace-log-1");
    expect(withReqId.length).toBeGreaterThan(0);
    await app.close();
  });

  it("非法 x-request-id（超长/含特殊字符）不透传，降级为新生成的 UUID", async () => {
    const app = buildApp();

    const tooLong = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "a".repeat(5000) },
    });
    const longId = tooLong.headers["x-request-id"] as string;
    expect(longId).not.toBe("a".repeat(5000));
    expect(longId).toMatch(/^[0-9a-f-]{36}$/);

    const injected = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": 'evil"id\nforged-log-line' },
    });
    expect(injected.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});
