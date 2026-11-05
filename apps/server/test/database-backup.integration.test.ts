import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { uuidv7 } from "uuidv7";
import { setupTestDb } from "./db-helper.js";
import { plainRecoveryTestUrl, recoveryConnections } from "./fixtures/recovery-connection.js";
import { encrypt, decrypt } from "../src/providers/crypto.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
const exec = promisify(execFile);
const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/backup-database.mjs", import.meta.url));
async function snapshot(client: postgres.Sql) {
  await client`set timezone='UTC'`;
  const tables =
    await client`select table_schema,table_name from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema') order by table_schema,table_name`;
  const rows: Record<string, string[]> = {};
  for (const table of tables) {
    const data =
      await client`select to_jsonb(r)::text as raw from ${client(table.table_schema)}.${client(table.table_name)} r order by to_jsonb(r)::text collate "C"`;
    rows[`${table.table_schema}.${table.table_name}`] = data.map((r) => r.raw as string);
  }
  const constraints =
    await client`select n.nspname as schema,t.relname as table_name,c.conname,pg_get_constraintdef(c.oid) as definition from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname in ('public','drizzle') order by 1,2,3`;
  const indexes =
    await client`select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','drizzle') order by 1,2,3`;
  const extensions = await client`select extname,extversion from pg_extension order by extname`;
  // PG17 reparsing flattens adjacent AND nodes in these two historical BETWEEN checks.
  // Normalize only the exact equivalent known spellings, never remove arbitrary parentheses.
  const equivalent = new Map([
    [
      "CHECK ((((max_attempts >= 1) AND (max_attempts <= 100)) AND ((attempts >= 0) AND (attempts <= max_attempts))))",
      "CHECK (((max_attempts >= 1) AND (max_attempts <= 100) AND ((attempts >= 0) AND (attempts <= max_attempts))))",
    ],
    [
      "CHECK ((((backoff_base_ms >= 1) AND (backoff_base_ms <= backoff_cap_ms)) AND (backoff_cap_ms <= 86400000)))",
      "CHECK (((backoff_base_ms >= 1) AND (backoff_base_ms <= backoff_cap_ms) AND (backoff_cap_ms <= 86400000)))",
    ],
  ]);
  const sequences =
    await client`select schemaname,sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value from pg_sequences where schemaname in ('public','drizzle') order by 1,2`;
  return {
    rows,
    constraints: constraints.map((c) => ({
      ...c,
      definition: equivalent.get(c.definition as string) ?? c.definition,
    })),
    indexes: [...indexes],
    extensions: [...extensions],
    sequences: [...sequences],
  };
}
it("native backup -> clear a database created by this test -> restore preserves every table, constraints, encrypted config and exact provenance", async () => {
  // Must precede setupTestDb: postgres-js URL queries can override startup database/options.
  for (const value of [process.env.DATABASE_URL, process.env.MNEMIC_TEST_ADMIN_URL])
    if (value !== undefined) plainRecoveryTestUrl(value);
  const testDb = await setupTestDb();
  const name = `mnemic_recovery_${uuidv7().replaceAll("-", "")}`;
  let adminSql: postgres.Sql | undefined,
    client: postgres.Sql | undefined,
    directory: string | undefined;
  let created = false;
  try {
    const { adminUrl, recoveryUrl } = recoveryConnections(
      testDb.url,
      process.env.MNEMIC_TEST_ADMIN_URL,
      name,
    );
    adminSql = postgres(adminUrl, { max: 1 });
    directory = await mkdtemp(join(tmpdir(), "mnemic-recovery-"));
    const archive = join(directory, "database.dump");
    const url = new URL(recoveryUrl);
    const env = {
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGDATABASE: name,
      PGPASSWORD: decodeURIComponent(url.password),
      PGPASSFILE: "/dev/null",
      PGCONNECT_TIMEOUT: "10",
    };
    await adminSql`create database ${adminSql(name)} template template0`;
    created = true; // Destruction below is allowed only after THIS process successfully created this UUID DB.
    client = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: migrations });
    const p = uuidv7(),
      c = uuidv7(),
      m = uuidv7(),
      o = uuidv7(),
      b = uuidv7(),
      v1 = uuidv7(),
      v2 = uuidv7(),
      provider = uuidv7();
    const raw =
      '{"budget":9007199254740993,"ratio":0.12345678901234567890,"nested":[null,true,"中文"]}';
    const fakeKey = "sk-recovery-offline-secret-123456789012345678901234";
    await client`insert into projects(id,name,meta) values(${p},'recovery',${raw}::jsonb)`;
    await client`insert into conversations(id,project_id,title) values(${c},${p},'source')`;
    await client`insert into messages(id,conversation_id,speaker,raw_text,msg_time,attachment) values(${m},${c},'user',${"source\n中文 😀"},'2026-11-05T00:00:00.123456Z',null)`;
    await client`insert into observations(id,project_id,type,subject,attribute,value,evidence_id,assertion_intent,source_type,authority) values(${o},${p},'fact','recovery','db',${raw}::jsonb,${m},'ASSERT','USER_EXPLICIT',60)`;
    await client`insert into beliefs(id,project_id,subject,attribute,confidence,salience,importance) values(${b},${p},'recovery','db',0.875,0.5,1)`;
    await client`insert into belief_versions(id,belief_id,value,valid_from,valid_to,recorded_from,recorded_to,source_observation_id) values(${v1},${b},${raw}::jsonb,'2026-11-01T00:00:00.123456Z','2026-11-05T00:00:00.654321Z','2026-11-02T00:00:00.111111Z','2026-11-05T00:00:00.654321Z',${o})`;
    await client`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,supersedes_version_id,source_observation_id) values(${v2},${b},'"SQLite"'::jsonb,'2026-11-05T00:00:00.654321Z','2026-11-05T00:00:00.654321Z',${v1},${o})`;
    await client`update beliefs set current_version_id=${v2} where id=${b}`;
    const vector = "[" + Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",") + "]";
    await client`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${v2},${vector}::vector,'offline-recovery')`;
    await client`insert into audit_log(id,ts,actor,action,meta) values(${uuidv7()},'2026-11-05T00:00:00.123456Z','fixture','unknown.history',${raw}::jsonb)`;
    await client`insert into provider_configs(id,name,protocol,base_url,api_key_encrypted,models) values(${provider},'offline','openai-compatible','https://offline.example.invalid',${encrypt(fakeKey, TEST_MASTER_KEY)},'{"chat":"offline"}'::jsonb)`;
    await client`update feature_flags set revision=1,flags=jsonb_set(flags,'{retrieval_keyword}','false'::jsonb)`;
    await client`insert into memory_tasks(id,project_id,type,payload,idempotency_key) values(${uuidv7()},${p},'EXTRACT',${JSON.stringify({ evidence_id: m })}::jsonb,'recovery-extract')`;
    await client`insert into pending_candidates(id,project_id,candidate,gate_scores,ttl_expires_at,evidence_id) values(${uuidv7()},${p},${raw}::jsonb,'null'::jsonb,now()+interval '1 day',${m})`;
    await client`insert into model_usage(id,project_id,conversation_id,provider_name,model_id,slot,purpose,status,started_at,duration_ms,total_tokens) values(${uuidv7()},${p},${c},'offline','offline','chat','chat','aborted',now(),0,9007199254740993)`;
    const before = await snapshot(client);
    expect(Object.keys(before.rows)).toContain("drizzle.__drizzle_migrations");
    expect(Object.keys(before.rows)).toContain("public.memory_tasks");
    expect(Object.keys(before.rows)).toContain("public.provider_configs");
    const backup = await exec(process.execPath, [script, "--output", archive], {
      env,
      timeout: 60000,
    });
    expect(backup.stdout.trim()).toBe("BACKUP_CREATED");
    expect(backup.stderr).toBe("");
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect((await readFile(archive)).subarray(0, 5).toString()).toBe("PGDMP");
    await client.end();
    client = undefined;
    // No --force, no session termination, no user-selected target, no existing DB can pass created flag.
    expect(created).toBe(true);
    expect(name).toMatch(/^mnemic_recovery_[0-9a-f]{32}$/);
    await adminSql`drop database ${adminSql(name)}`;
    created = false;
    await adminSql`create database ${adminSql(name)} template template0`;
    created = true;
    client = postgres(url.toString(), { max: 1 });
    expect(
      await client`select table_name from information_schema.tables where table_schema='public'`,
    ).toEqual([]);
    await exec(
      "pg_restore",
      [
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--no-password",
        "--dbname",
        name,
        archive,
      ],
      { env, timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    expect(await snapshot(client)).toEqual(before);
    await expect(client`update memory_tasks set max_attempts=101`).rejects.toMatchObject({
      code: "23514",
    });
    await expect(client`update memory_tasks set backoff_base_ms=86400001`).rejects.toMatchObject({
      code: "23514",
    });
    const [restored] =
      await client`select api_key_encrypted from provider_configs where id=${provider}`;
    expect(decrypt(restored!.api_key_encrypted as string, TEST_MASTER_KEY)).toBe(fakeKey);
    const versions =
      await client`select id,supersedes_version_id,source_observation_id,recorded_to::text from belief_versions where belief_id=${b} order by id`;
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      id: v2,
      supersedes_version_id: v1,
      source_observation_id: o,
      recorded_to: null,
    });
    expect((await client`select evidence_id from observations where id=${o}`)[0]!.evidence_id).toBe(
      m,
    );
    await migrate(drizzle(client), { migrationsFolder: migrations });
    expect(await snapshot(client)).toEqual(before);
  } finally {
    try {
      await client?.end();
      if (created && adminSql) await adminSql`drop database ${adminSql(name)}`;
    } finally {
      await adminSql?.end();
      await testDb.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}, 180000);
