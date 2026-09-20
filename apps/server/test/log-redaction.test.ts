import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("日志脱敏", () => {
  it("authorization 头在日志中被替换为 [REDACTED]，原始 token 不出现", async () => {
    const secret = "Bearer sk-test-secret-token";
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
      headers: { authorization: secret },
    });

    const raw = lines.join("");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
    await app.close();
  });
});
