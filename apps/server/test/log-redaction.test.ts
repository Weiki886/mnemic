import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("日志脱敏", () => {
  // 每个敏感头独立断言：redact.paths 漏配哪个就抓哪个（#62 实测 cookie/x-api-key 原样入日志）
  for (const [header, secret] of [
    ["authorization", "Bearer sk-test-secret-token"],
    ["cookie", "sid=SECRET-COOKIE-VALUE"],
    ["x-api-key", "sk-test-api-key-secret"],
  ] as const) {
    it(`${header} 头在日志中被替换为 [REDACTED]，原始值不出现`, async () => {
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
        headers: { [header]: secret },
      });

      const raw = lines.join("");
      expect(raw).not.toContain(secret);
      expect(raw).toContain("[REDACTED]");
      await app.close();
    });
  }
});
