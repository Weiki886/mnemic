import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("启动入口鉴权门禁", () => {
  it("缺 Token 时在数据库初始化/监听之前退出，环境值不落错误消息", async () => {
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", entry], {
      env: {
        ...process.env,
        MNEMIC_AUTH_TOKEN: "",
        DATABASE_URL: "postgres://invalid.test/not-used",
      },
      timeout: 5000,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => error,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("MNEMIC_AUTH_TOKEN");
    expect(result.stderr).not.toContain("invalid.test");
    expect(result.stderr).not.toContain("Server listening");
  });
});
