import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const script = new URL("./prepare-pnpm.mjs", import.meta.url);
const root = new URL("../", import.meta.url);
const success = { status: 0, stdout: "Preparing pnpm@10.32.0", stderr: "" };
const failure = (stderr, status = 1) => ({ status, stdout: "", stderr });

async function exercise(results, packageManager = "pnpm@10.32.0") {
  assert.ok(existsSync(script), "shared pnpm bootstrap must exist");
  const { preparePnpm } = await import(script.href);
  const calls = [];
  const waits = [];
  const logs = [];
  const code = await preparePnpm(packageManager, {
    run: (...args) => {
      calls.push(args);
      assert.ok(calls.length <= results.length, "unexpected extra bootstrap attempt");
      return results[calls.length - 1];
    },
    wait: async (ms) => waits.push(ms),
    log: (message) => logs.push(message),
  });
  return { code, calls, waits, logs };
}

test("prepares the exact pinned version without a shell or retry on success", async () => {
  const result = await exercise([success]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.waits, []);
  assert.deepEqual(result.calls[0].slice(0, 2), [
    "corepack",
    ["prepare", "pnpm@10.32.0", "--activate"],
  ]);
  const options = result.calls[0][2];
  assert.equal(options.shell, undefined);
  assert.equal(options.timeout, 150_000);
  assert.equal(options.killSignal, "SIGKILL");
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});

test("retries only the allowlisted HTTP statuses with bounded backoff", async () => {
  for (const status of [429, 502, 503, 504]) {
    const result = await exercise([
      failure(`Internal Error: Server answered with HTTP ${status} when performing the request`),
      failure(`Internal Error: Server answered with HTTP ${status} when performing the request`),
      success,
    ]);
    assert.equal(result.code, 0, String(status));
    assert.equal(result.calls.length, 3);
    assert.deepEqual(result.waits, [5000, 15000]);
    assert.ok(result.logs.some((message) => message.includes("1/3")));
  }
});

test("three persistent 503 responses fail the build and preserve the last exit code", async () => {
  const unavailable = failure("Server answered with HTTP 503", 17);
  const result = await exercise([unavailable, unavailable, unavailable]);
  assert.equal(result.code, 17);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.waits, [5000, 15000]);
  assert.ok(result.logs.some((message) => message.includes("503")));
});

test("authentication, nonexistent versions, signatures and unknown failures stop immediately", async () => {
  for (const message of [
    "Server answered with HTTP 400",
    "Server answered with HTTP 401",
    "Server answered with HTTP 403",
    "Server answered with HTTP 404",
    "Server answered with HTTP 500",
    "Cannot find matching keyid",
    "Signature does not match",
    "Package not found",
    "Unknown Internal Error",
  ]) {
    const result = await exercise([failure(message, 7)]);
    assert.equal(result.code, 7, message);
    assert.equal(result.calls.length, 1, message);
    assert.deepEqual(result.waits, []);
  }
});

test("explicit network error codes may recover without retrying arbitrary fetch failures", async () => {
  for (const code of [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]) {
    const result = await exercise([failure(`Error: fetch failed; cause: ${code}`), success]);
    assert.equal(result.code, 0, code);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.waits, [5000]);
  }
  const unknown = await exercise([failure("TypeError: fetch failed")]);
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.waits, []);
});

test("own subprocess timeout is bounded and retryable", async () => {
  const result = await exercise([
    { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } },
    success,
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.waits, [5000]);
});

test("permanent errors take precedence even when diagnostics also mention a transient failure", async () => {
  for (const message of [
    "Signature does not match; last download returned Server answered with HTTP 503",
    "Cannot find matching keyid; ECONNRESET",
    "Integrity check failed; ETIMEDOUT",
    "Certificate verification failed; Server answered with HTTP 502",
    "Server answered with HTTP 403; ECONNRESET",
    "EACCES: permission denied; previous fetch cause ECONNRESET",
    "EPERM: operation not permitted; Server answered with HTTP 503",
    "Package not found; prior request Server answered with HTTP 503",
    "No matching version found; ETIMEDOUT",
    "Version not found; Server answered with HTTP 502",
  ]) {
    const result = await exercise([failure(message, 9)]);
    assert.equal(result.code, 9);
    assert.deepEqual(result.waits, []);
  }
  const timeoutAfterForbidden = await exercise([
    {
      status: null,
      error: { code: "ETIMEDOUT" },
      stderr: "Server answered with HTTP 403",
    },
  ]);
  assert.equal(timeoutAfterForbidden.code, 1);
  assert.deepEqual(timeoutAfterForbidden.waits, []);
});

test("missing executable and external termination do not retry or report success", async () => {
  for (const result of [
    { status: null, error: { code: "ENOENT" } },
    { status: null, signal: "SIGTERM" },
    { status: null, signal: "SIGKILL" },
  ]) {
    const actual = await exercise([result]);
    assert.equal(actual.code, 1);
    assert.equal(actual.calls.length, 1);
    assert.deepEqual(actual.waits, []);
  }
});

test("rejects non-pinned or non-pnpm package managers before executing anything", async () => {
  for (const value of [
    undefined,
    "pnpm@latest",
    "pnpm@^10.32.0",
    "npm@10.32.0",
    "pnpm@10.32.0;exit 0",
  ]) {
    const result = await exercise([], value === undefined ? null : value);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
  }
});

test("both Docker builds use the shared bootstrap before copying application sources", async () => {
  for (const path of ["apps/server/Dockerfile", "apps/web/Dockerfile"]) {
    const source = await readFile(new URL(path, root), "utf8");
    const run = source.indexOf("RUN corepack enable && node scripts/prepare-pnpm.mjs");
    assert.ok(run >= 0, `${path}: shared bootstrap must run`);
    for (const copy of [
      "COPY package.json ./",
      "COPY scripts/prepare-pnpm.mjs ./scripts/prepare-pnpm.mjs",
    ]) {
      const index = source.indexOf(copy);
      assert.ok(index >= 0 && index < run, `${path}: ${copy} must precede bootstrap`);
    }
    assert.ok(source.indexOf("COPY . .") > run);
    assert.ok(!source.includes("corepack prepare pnpm@"));
  }
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.ok(ci.includes("node --test scripts/*.test.mjs"), "CI must execute bootstrap tests");
});

test("actual entrypoint reads the repository pin independently of cwd and propagates exit status", async () => {
  assert.ok(existsSync(script), "shared pnpm bootstrap must exist");
  const directory = await mkdtemp(join(tmpdir(), "mnemic-corepack-test-"));
  try {
    // Only the external download command is replaced; run the real script as a subprocess.
    const fake = join(directory, "corepack");
    await writeFile(
      fake,
      `#!${process.execPath}\n` +
        'const expected = ["prepare", "pnpm@10.32.0", "--activate"];\n' +
        "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(99);\n" +
        'console.error("Server answered with HTTP 403");\n' +
        "process.exit(23);\n",
      { mode: 0o700 },
    );
    const result = spawnSync(process.execPath, [fileURLToPath(script)], {
      cwd: directory,
      env: { ...process.env, PATH: directory },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stderr, /403/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
