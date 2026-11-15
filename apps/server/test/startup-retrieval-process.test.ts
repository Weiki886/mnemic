import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_MASTER_KEY } from "./test-keys.js";
it.each(["{private-sentinel", JSON.stringify({ api_key: "private-sentinel" })])(
  "entry rejects invalid binding before connecting to unreachable DB",
  (raw) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        PATH: process.env.PATH,
        MNEMIC_AUTH_TOKEN: "offline-startup-token-00000000000000",
        MNEMIC_MASTER_KEY: TEST_MASTER_KEY.toString("hex"),
        DATABASE_URL: "postgres://offline:offline@127.0.0.1:1/mnemic_test",
        MNEMIC_RETRIEVAL_BINDING_JSON: raw,
        DEEPSEEK_API_KEY: "",
        DASHSCOPE_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(child.status).not.toBe(0);
    expect(child.error).toBeUndefined();
    const output = child.stdout + child.stderr;
    expect(output).toContain("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
    expect(output).not.toContain("private-sentinel");
    expect(output).not.toContain("ECONNREFUSED");
  },
);
