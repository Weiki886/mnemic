import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

test("redacts secrets before trimming either command-output stream", async () => {
  const moduleUrl = new URL("./deployment-output.mjs", import.meta.url);
  assert.ok(existsSync(moduleUrl), "deployment output sanitizer must exist");
  const { summarizeOutput } = await import(moduleUrl.href);
  const secret = "private-" + "q".repeat(56);
  const stdout = secret + "x".repeat(5950);
  const stderr = secret + "y".repeat(2450);
  const output = summarizeOutput(stdout, stderr, [secret]);
  assert.ok(!output.includes("q"), "truncated secret suffix must not leak");
  assert.ok(output.includes("[REDACTED]"));
  assert.equal(summarizeOutput("hello", "error", [secret]), "hello\nerror");
});
