// Docker bootstrap only: retry the download, never installation, migrations or deployment.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, URL } from "node:url";

const transientCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const transientStatuses = new Set([429, 502, 503, 504]);

function transientFailure(result, output) {
  // Permanent failures win even if another diagnostic mentions networking.
  if (
    /signature|keyid|integrity|checksum|certificate|\b(?:EACCES|EPERM|ENOENT|ETARGET|ENOTFOUND)\b|permission denied|access denied|(?:package|version) not found|no matching version/i.test(
      output,
    )
  )
    return false;
  // Corepack exposes HTTP failures as text, not structured exit codes. Unknown formats fail closed.
  const statuses = [...output.matchAll(/\bServer answered with HTTP (\d{3})\b/g)];
  if (statuses.some((match) => !transientStatuses.has(Number(match[1])))) return false;
  if (result.error) return transientCodes.has(result.error.code);
  if (result.signal) return false;
  if (statuses.length) return true;
  return [...transientCodes].some((code) => new RegExp(`\\b${code}\\b`).test(output));
}

export async function preparePnpm(
  packageManager,
  { run = spawnSync, wait = delay, log = console.error } = {},
) {
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
    log("Bootstrap requires package.json packageManager pinned to pnpm@x.y.z.");
    return 1;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = run("corepack", ["prepare", packageManager, "--activate"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 150_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (output) log(output);
    if (result.status === 0 && !result.error && !result.signal) return 0;
    if (attempt === 2 || !transientFailure(result, output)) {
      log(`Corepack prepare failed at attempt ${attempt + 1}/3; build remains failed.`);
      return result.status > 0 ? result.status : 1;
    }
    const ms = [5000, 15000][attempt];
    log(`Transient Corepack failure at attempt ${attempt + 1}/3; retrying in ${ms}ms.`);
    await wait(ms);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { packageManager } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  );
  process.exitCode = await preparePnpm(packageManager);
}
