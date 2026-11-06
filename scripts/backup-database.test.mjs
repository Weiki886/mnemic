import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, readdir, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { backupDatabase, runBackupCommand } from "./backup-database.mjs";

const secret = "offline-db-password-do-not-print-123456789";
const source = {
  PGHOST: "127.0.0.1",
  PGPORT: "5432",
  PGUSER: "operator",
  PGDATABASE: "offline_db",
  PGPASSWORD: secret,
};
async function fixture(mode = "ok") {
  const dir = await mkdtemp(join(tmpdir(), "mnemic-backup-unit-")),
    out = join(dir, "new.dump"),
    calls = join(dir, "calls.jsonl");
  const code = `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nconst tool=process.argv[1].endsWith('pg_dump')?'dump':'restore';\nconst args=process.argv.slice(2);\nif(args.includes('--version')){process.stdout.write(tool==='dump'?'pg_dump (PostgreSQL) 17.9':'pg_restore (PostgreSQL) 17.9');process.exit(0);}\nappendFileSync(${JSON.stringify(calls)},JSON.stringify({tool,args,password:process.env.PGPASSWORD,db:process.env.PGDATABASE,service:process.env.PGSERVICE,options:process.env.PGOPTIONS,env:process.env.MNEMIC_MASTER_KEY})+'\\n');\nif(tool==='dump'){process.stdout.write(Buffer.from([80,71,68,77,80,0,255,128]));if(${JSON.stringify(mode)}==='failed'){process.stderr.write(process.env.PGPASSWORD);process.exit(2);}}else if(${JSON.stringify(mode)}==='badarchive'){process.stderr.write(process.env.PGPASSWORD);process.exit(1);}else{if(readFileSync(args.at(-1))[0]!==80)process.exit(2);process.stdout.write('sensitive table listing');}\n`;
  await writeFile(join(dir, "pg_dump"), code, { mode: 0o700 });
  await writeFile(join(dir, "pg_restore"), code, { mode: 0o700 });
  const env = {
    ...source,
    PATH: dir + ":" + process.env.PATH,
    CALLS: calls,
    MODE: mode,
    PGSERVICE: "must-not-inherit",
    PGOPTIONS: "must-not-inherit",
    MNEMIC_MASTER_KEY: secret,
  };
  return { dir, out, calls, env, close: () => rm(dir, { recursive: true, force: true }) };
}
test("native backup streams binary bytes, publishes0600 exclusively, uses explicit connection env and never argv credentials", async () => {
  const f = await fixture();
  try {
    await backupDatabase(f.out, f.env);
    assert.deepEqual(await readFile(f.out), Buffer.from([80, 71, 68, 77, 80, 0, 255, 128]));
    assert.equal((await stat(f.out)).mode & 0o777, 0o600);
    const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["--format=custom", "--no-owner", "--no-acl", "--no-password"]);
    assert.ok(calls.every((c) => !JSON.stringify(c.args).includes(secret)));
    assert.ok(
      calls.every(
        (c) =>
          c.password === secret &&
          c.db === "offline_db" &&
          c.service === undefined &&
          c.options === undefined &&
          c.env === undefined,
      ),
    );
    assert.deepEqual((await readdir(f.dir)).sort(), [
      "calls.jsonl",
      "new.dump",
      "pg_dump",
      "pg_restore",
    ]);
  } finally {
    await f.close();
  }
});
test("existing output including symlinks is never overwritten", async () => {
  const f = await fixture();
  try {
    await writeFile(f.out, "keep");
    await assert.rejects(backupDatabase(f.out, f.env), { message: "BACKUP_OUTPUT_EXISTS" });
    assert.equal(await readFile(f.out, "utf8"), "keep");
    await symlink(f.out, join(f.dir, "link.dump"));
    await assert.rejects(backupDatabase(join(f.dir, "link.dump"), f.env), {
      message: "BACKUP_OUTPUT_EXISTS",
    });
    assert.equal(await readFile(f.out, "utf8"), "keep");
  } finally {
    await f.close();
  }
});
for (const mode of ["failed", "badarchive"])
  test(`${mode} is fixed failure without partial output or raw stderr`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        backupDatabase(f.out, f.env),
        (e) =>
          e.message === "BACKUP_FAILED" && !String(e).includes(secret) && e.cause === undefined,
      );
      assert.ok(!(await readdir(f.dir)).includes("new.dump"));
      assert.ok(!(await readdir(f.dir)).some((n) => n.startsWith(".mnemic-backup-")));
    } finally {
      await f.close();
    }
  });
for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE"])
  test(`missing ${name} cannot fall back to inherited DATABASE_URL or service`, async () => {
    const f = await fixture();
    try {
      const env = { ...f.env, DATABASE_URL: "postgres://real-user:" + secret + "@realhost/realdb" };
      delete env[name];
      await assert.rejects(backupDatabase(f.out, env), { message: "BACKUP_CONNECTION_REQUIRED" });
      assert.ok(!(await readdir(f.dir)).includes("calls.jsonl"));
    } finally {
      await f.close();
    }
  });
for (const value of ["postgres://host/db", "dbname=other", "-bad", "a\nb", "", "x".repeat(64)])
  test(`unsafe database spelling ${JSON.stringify(value)} is rejected before tools`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(backupDatabase(f.out, { ...f.env, PGDATABASE: value }), {
        message: value === "" ? "BACKUP_CONNECTION_REQUIRED" : "BACKUP_CONNECTION_INVALID",
      });
      assert.ok(!(await readdir(f.dir)).includes("calls.jsonl"));
    } finally {
      await f.close();
    }
  });
test("unsupported tool major version is fixed failure with no final file", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.dir, "pg_dump"),
      `#!${process.execPath}\nprocess.stdout.write('pg_dump (PostgreSQL) 18.4');`,
      { mode: 0o700 },
    );
    await assert.rejects(backupDatabase(f.out, f.env), { message: "BACKUP_TOOL_VERSION" });
    assert.ok(!(await readdir(f.dir)).includes("new.dump"));
  } finally {
    await f.close();
  }
});
test("help and invalid arguments do not require connection env or access backup tools", async () => {
  const logs = [];
  assert.equal(await runBackupCommand(["--help"], {}, (s) => logs.push(s)), 0);
  assert.ok(logs[0].includes("--output"));
  for (const args of [
    [],
    ["--output"],
    ["--output", "a", "--output", "b"],
    ["--clean"],
    ["--output", "a", "--unknown"],
  ]) {
    const output = [];
    assert.equal(await runBackupCommand(args, {}, (s) => output.push(s)), 1);
    assert.deepEqual(output, ["BACKUP_ARGUMENTS_INVALID"]);
  }
});
test("CLI failure prints only stable message, never library stack/password/raw stderr", async () => {
  const f = await fixture("failed");
  try {
    const script = new URL("./backup-database.mjs", import.meta.url);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script.pathname, "--output", f.out], { env: f.env });
      let output = "";
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.output.trim(), "BACKUP_FAILED");
  } finally {
    await f.close();
  }
});

for (const port of ["0", "65536", "5432\n", "abc", ""])
  test(`invalid port ${JSON.stringify(port)} cannot select another endpoint`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(backupDatabase(f.out, { ...f.env, PGPORT: port }), {
        message: port === "" ? "BACKUP_CONNECTION_REQUIRED" : "BACKUP_CONNECTION_INVALID",
      });
      assert.ok(!(await readdir(f.dir)).includes("calls.jsonl"));
    } finally {
      await f.close();
    }
  });
test("publication race cannot replace a file created after initial validation", async () => {
  const f = await fixture();
  try {
    const tool = join(f.dir, "pg_dump");
    const original = await readFile(tool, "utf8");
    await writeFile(
      tool,
      original.replace(
        "if(tool==='dump'){",
        `if(tool==='dump'){appendFileSync(${JSON.stringify(f.out)},'racer');`,
      ),
      { mode: 0o700 },
    );
    await assert.rejects(backupDatabase(f.out, f.env), { message: "BACKUP_OUTPUT_EXISTS" });
    assert.equal(await readFile(f.out, "utf8"), "racer");
    assert.ok(!(await readdir(f.dir)).some((n) => n.startsWith(".mnemic-backup-")));
  } finally {
    await f.close();
  }
});
