// Disposable stack only: no real .env, model calls, host DB or global CA installation.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { summarizeOutput } from "./deployment-output.mjs";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "mnemic-deployment-"));
const project = `mnemic-smoke-${randomUUID()}`;
const secret = () => randomBytes(32).toString("hex");
const password = secret();
const token = secret();
const masterKey = secret();
const providerKey = `sk-smoke-${secret()}`;
const envFile = join(directory, ".env");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
const httpPort = await freePort();
let httpsPort = await freePort();
while (httpsPort === httpPort) httpsPort = await freePort();
await writeFile(
  envFile,
  [
    "MNEMIC_DOMAIN=localhost",
    `POSTGRES_PASSWORD=${password}`,
    `MNEMIC_AUTH_TOKEN=${token}`,
    `MNEMIC_MASTER_KEY=${masterKey}`,
    `MNEMIC_IMAGE_TAG=${project}`,
    "MNEMIC_BIND_IP=127.0.0.1",
    `MNEMIC_HTTP_PORT=${httpPort}`,
    `MNEMIC_HTTPS_PORT=${httpsPort}`,
  ].join("\n") + "\n",
  { mode: 0o600 },
);

// Explicit env overrides inherited secrets; --env-file prevents loading repository .env.
const env = {
  ...process.env,
  POSTGRES_PASSWORD: password,
  MNEMIC_AUTH_TOKEN: token,
  MNEMIC_MASTER_KEY: masterKey,
  MNEMIC_DOMAIN: "localhost",
  MNEMIC_IMAGE_TAG: project,
  MNEMIC_BIND_IP: "127.0.0.1",
  MNEMIC_HTTP_PORT: String(httpPort),
  MNEMIC_HTTPS_PORT: String(httpsPort),
};
async function compose(...args) {
  return exec(
    "docker",
    ["compose", "--env-file", envFile, "-p", project, "-f", "docker-compose.yml", ...args],
    { cwd, env, timeout: 900_000, maxBuffer: 20 * 1024 * 1024 },
  );
}

let ca;
function request(path, { secure = true, method = "GET", bearer, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (secure ? https : http).request(
      {
        hostname: "127.0.0.1",
        servername: "localhost",
        port: secure ? httpsPort : httpPort,
        path,
        method,
        ca,
        rejectUnauthorized: true,
        headers: {
          host: `localhost:${secure ? httpsPort : httpPort}`,
          ...headers,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: 10_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.end(payload);
  });
}

let failed = false;
let phase = "build";
try {
  console.info("Building isolated deployment stack...");
  await compose("config", "--quiet");
  await compose("up", "--build", "-d", "--wait", "--wait-timeout", "180");
  phase = "TLS startup";
  for (let attempt = 0; ; attempt++) {
    try {
      await compose(
        "cp",
        "caddy:/data/caddy/pki/authorities/local/root.crt",
        join(directory, "root.crt"),
      );
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(1000);
    }
  }
  ca = await readFile(join(directory, "root.crt"));
  for (let attempt = 0; ; attempt++) {
    try {
      assert.equal((await request("/api/health")).status, 200);
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(1000);
    }
  }
  phase = "API assertions";

  const redirect = await request("/api/health", { secure: false });
  assert.equal(redirect.status, 308);
  assert.match(redirect.headers.location, /^https:\/\/localhost/);
  for (const path of ["/", "/memories/smoke-route"]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.match(response.text, /<html/);
  }
  assert.equal((await request("/api/health")).status, 200);
  for (const bearer of [undefined, "wrong-token"]) {
    const response = await request("/api/v1/doctor", { bearer });
    assert.equal(response.status, 401);
    assert.match(response.headers["content-type"], /application\/problem\+json/);
  }
  let response = await request("/api/v1/doctor", { bearer: token });
  assert.equal(response.status, 200);
  let report = JSON.parse(response.text);
  for (const name of ["database", "authentication"]) {
    assert.equal(report.checks.find((check) => check.name === name)?.status, "ok");
  }
  assert.equal(report.checks.find((check) => check.name === "configuration")?.status, "error");

  // Offline fake provider validates encryption + masked views without any billable probes.
  response = await request("/api/providers", {
    bearer: token,
    method: "POST",
    body: {
      name: "smoke-offline",
      protocol: "openai-compatible",
      base_url: "https://example.invalid/v1",
      api_key: providerKey,
      models: { chat: "offline-chat", extraction: "offline-extract", embedding: "offline-embed" },
    },
  });
  assert.equal(response.status, 201);
  assert.ok(!response.text.includes(providerKey));
  response = await request("/api/v1/doctor", { bearer: token });
  report = JSON.parse(response.text);
  assert.equal(report.ok, true);
  assert.equal(report.probe, false);
  assert.equal(report.checks.find((check) => check.name === "configuration")?.status, "ok");
  for (const name of ["chat", "extraction", "embedding"]) {
    assert.equal(report.checks.find((check) => check.name === name)?.status, "skipped");
  }

  const projectId = randomUUID();
  await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "mnemic",
    "-d",
    "mnemic",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `INSERT INTO projects (id, name) VALUES ('${projectId}', 'deployment-smoke')`,
  );
  response = await request("/api/v1/conversations", {
    bearer: token,
    method: "POST",
    body: { project_id: projectId, title: "Offline smoke" },
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).project_id, projectId);
  assert.equal(
    (await request(`/api/projects/${projectId}/beliefs`, { bearer: token })).status,
    200,
  );
  await compose("run", "--rm", "--no-deps", "migrate");
  assert.equal((await compose("exec", "-T", "web", "id", "-u")).stdout.trim(), "1000");
  await compose(
    "exec",
    "-T",
    "web",
    "sh",
    "-ec",
    [
      "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/1/status",
      "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/1/status",
      "grep -Eq '^CapBnd:[[:space:]]+0+$' /proc/1/status",
      "if touch /srv/.hardening-smoke 2>/dev/null; then rm /srv/.hardening-smoke; exit 1; fi",
      'for dir in /tmp /data /config; do touch "$dir/.hardening-smoke"; rm "$dir/.hardening-smoke"; done',
    ].join("; "),
  );
  await compose(
    "exec",
    "-T",
    "caddy",
    "sh",
    "-ec",
    "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/1/status",
  );
  // Only restart this disposable proxy: its CA must survive in the persistent certificate volume.
  await compose("restart", "caddy");
  for (let attempt = 0; ; attempt++) {
    try {
      assert.equal((await request("/api/health")).status, 200);
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(1000);
    }
  }
  const persistedCA = await compose(
    "exec",
    "-T",
    "caddy",
    "cat",
    "/data/caddy/pki/authorities/local/root.crt",
  );
  assert.equal(persistedCA.stdout, ca.toString("utf8"));
  assert.equal((await compose("exec", "-T", "server", "id", "-u")).stdout.trim(), "1000");
  await compose(
    "exec",
    "-T",
    "server",
    "node",
    "-e",
    "if(require('node:fs').existsSync('/app/.env'))process.exit(1)",
  );
  // Exercise proxy failures too: disabling access logs alone does not suppress Caddy error requests.
  await compose("stop", "server");
  const unavailable = await request(`/api/v1/doctor?token=${token}`, {
    bearer: token,
    headers: { "x-api-key": providerKey },
  });
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.text, "502 Bad Gateway");
  const logs = await compose("logs", "--no-color");
  for (const value of [password, token, masterKey, providerKey]) {
    assert.ok(!(logs.stdout + logs.stderr).includes(value), "Secret found in container logs");
  }
  console.info(
    "PASS: migrations, trusted local HTTPS, persistent CA, hardened Web/proxy, SPA, authentication, encrypted config and API; no model calls.",
  );
} catch (error) {
  failed = true;
  // Only this disposable stack's output is shown, with all generated secrets removed.
  if (error instanceof assert.AssertionError) {
    console.error(
      `Deployment assertion failed at ${
        error.stack
          ?.split("\n")
          .find((line) => line.includes("verify-deployment.mjs:"))
          ?.trim() ?? "unknown"
      }`,
    );
  } else {
    console.error(`Deployment smoke failed during ${phase}.`);
    console.error(
      summarizeOutput(error.stdout ?? "", error.stderr ?? "", [
        password,
        token,
        masterKey,
        providerKey,
      ]),
    );
  }
} finally {
  try {
    assert.match(project, /^mnemic-smoke-[a-f0-9-]{36}$/);
    await compose("down", "--volumes", "--remove-orphans");
    console.info("Disposable stack and its volumes removed; existing services untouched.");
  } catch {
    failed = true;
    console.error(`Cleanup incomplete; remove only Compose project ${project}.`);
  }
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
