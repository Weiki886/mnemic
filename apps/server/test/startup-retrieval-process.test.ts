import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_MASTER_KEY } from "./test-keys.js";
it.each([
  "{private-sentinel",
  JSON.stringify({ api_key: "private-sentinel" }),
  JSON.stringify({
    fusion: { mode: "rrf", threshold: 0.001 },
    rerankerProvider: {},
    chatReadTimeResolution: "private-sentinel",
  }),
  JSON.stringify({
    fusion: { mode: "rrf", threshold: 0.001 },
    rerankerProvider: {},
    recallReadTimeResolution: "private-sentinel",
  }),
  JSON.stringify({
    fusion: { mode: "rrf", threshold: 0.001 },
    rerankerProvider: {},
    chatMemoryBudget: {
      maxTokens: 16,
      providerId: "01920000-0000-7000-8000-00000000000a",
      modelId: "offline",
      tokenizerFile: "/missing/private-sentinel",
      tokenizerConfigFile: "/missing/private-sentinel",
    },
  }),
  JSON.stringify({
    fusion: { mode: "rrf", threshold: 0.001 },
    rerankerProvider: {},
    recallMemoryBudget: {
      maxTokens: 16,
      tokenizerFile: "/missing/private-sentinel",
      tokenizerConfigFile: "/missing/private-sentinel",
    },
  }),
])("entry rejects invalid binding before connecting to unreachable DB", (raw) => {
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
});
