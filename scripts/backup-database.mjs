// Operator-invoked PG17 backup only. Never loads .env, DATABASE_URL or performs restore/cleanup SQL.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, lstat, link, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const failure = (code = "BACKUP_FAILED") => new Error(code);
function connectionEnv(env) {
  for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE"])
    if (typeof env[name] !== "string" || !env[name]) throw failure("BACKUP_CONNECTION_REQUIRED");
  if (
    !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(env.PGDATABASE) ||
    !/^\d{1,5}$/.test(env.PGPORT) ||
    Number(env.PGPORT) < 1 ||
    Number(env.PGPORT) > 65535 ||
    [env.PGHOST, env.PGUSER].some((s) => s.length > 1024 || /[\0\r\n]/.test(s))
  )
    throw failure("BACKUP_CONNECTION_INVALID");
  const child = {
    PATH: env.PATH ?? process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    PGCLIENTENCODING: "UTF8",
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "mnemic-backup",
    PGPASSFILE: env.PGPASSFILE || "/dev/null",
  };
  for (const name of [
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGDATABASE",
    "PGPASSWORD",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
    "PGSSLCRL",
    "PGCHANNELBINDING",
  ])
    if (typeof env[name] === "string") child[name] = env[name];
  return child;
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw failure("BACKUP_OUTPUT_INVALID");
  }
}
function run(tool, args, env, stdout = "ignore") {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      env,
      stdio: ["ignore", stdout, "ignore"],
      timeout: 600000,
      killSignal: "SIGKILL",
    });
    child.once("error", () => reject(failure()));
    child.once("close", (code) => (code === 0 ? resolve() : reject(failure())));
  });
}
async function version(tool, env) {
  let output;
  try {
    output = await exec(tool, ["--version"], {
      env,
      timeout: 10000,
      maxBuffer: 1024,
      killSignal: "SIGKILL",
    });
  } catch {
    throw failure();
  }
  if (!new RegExp(`^${tool} \\(PostgreSQL\\) 17\\.`).test(output.stdout))
    throw failure("BACKUP_TOOL_VERSION");
}

/** New-file publication only; output parent is an operator-trusted local POSIX directory. */
export async function backupDatabase(output, env = process.env) {
  if (typeof output !== "string" || !output || output.length > 4096 || /[\0\r\n]/.test(output))
    throw failure("BACKUP_OUTPUT_INVALID");
  const childEnv = connectionEnv(env);
  const target = resolve(output);
  if (await exists(target)) throw failure("BACKUP_OUTPUT_EXISTS");
  let directory, handle;
  try {
    const parent = await realpath(dirname(target));
    const destination = join(parent, basename(target));
    await version("pg_dump", childEnv);
    await version("pg_restore", childEnv);
    directory = await mkdtemp(join(parent, ".mnemic-backup-"));
    const partial = join(directory, "database.dump");
    handle = await open(partial, "wx", 0o600);
    await run(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl", "--no-password"],
      childEnv,
      handle.fd,
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Native TOC check is not a substitute for an actual recovery rehearsal.
    await run("pg_restore", ["--list", partial], childEnv);
    try {
      await link(partial, destination);
    } catch (error) {
      if (error.code === "EEXIST") throw failure("BACKUP_OUTPUT_EXISTS");
      throw failure();
    }
  } catch (error) {
    if (error.message === "BACKUP_OUTPUT_EXISTS" || error.message === "BACKUP_TOOL_VERSION")
      throw error;
    throw failure();
  } finally {
    await handle?.close().catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
export async function runBackupCommand(args, env = process.env, write = (s) => console.log(s)) {
  if (args.length === 1 && args[0] === "--help") {
    write(
      "Usage: node scripts/backup-database.mjs --output NEW_FILE\nExplicit PGHOST PGPORT PGUSER PGDATABASE required; PG17 tools in PATH. No restore or overwrite.",
    );
    return 0;
  }
  if (args.length !== 2 || args[0] !== "--output" || !args[1] || args[1].startsWith("--")) {
    write("BACKUP_ARGUMENTS_INVALID");
    return 1;
  }
  try {
    await backupDatabase(args[1], env);
    write("BACKUP_CREATED");
    return 0;
  } catch (error) {
    write(error.message);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runBackupCommand(process.argv.slice(2));
