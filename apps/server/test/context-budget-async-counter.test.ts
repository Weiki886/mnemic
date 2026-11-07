import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("rejects an accidental async counter without letting its rejected promise crash the process", () => {
  const moduleUrl = new URL("../src/retrieval/context-budget.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { packMemoryContext } from ${JSON.stringify(moduleUrl)};
    try {
      packMemoryContext({maxTokens:1,candidates:[]}, () => Promise.reject(Error("offline counter")));
      process.exit(2);
    } catch (error) {
      if (error.message !== "MEMORY_TOKEN_COUNT_FAILED") process.exit(3);
    }
    setImmediate(() => process.stdout.write("handled"));
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("handled");
});
