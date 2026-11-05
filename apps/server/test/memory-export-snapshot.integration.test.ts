import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { memoryExportDb } from "./fixtures/memory-export-db.js";
import { prepareMemoryExport } from "../src/data-export/repository.js";
import { decodeMemoryExport, MEMORY_EXPORT_LIMITS } from "../src/data-export/codec.js";
import { MEMORY_EXPORT_TABLES } from "../src/data-export/format.js";
import { publicAuditRow } from "../src/audit/events.js";
let t: Awaited<ReturnType<typeof memoryExportDb>>;
beforeAll(async () => {
  t = await memoryExportDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
afterEach(async () => {
  for (const table of [...MEMORY_EXPORT_TABLES].reverse()) await t.sql`delete from ${t.sql(table)}`;
});
it("empty snapshot excludes its own prepared receipt; next export includes prior history with safe queryable metadata", async () => {
  const first = await prepareMemoryExport(t.db);
  const archive = decodeMemoryExport(first.payload);
  expect(archive.records).toEqual([]);
  const [receipt] = await t.sql`select * from audit_log`;
  expect(receipt).toMatchObject({
    actor: "server",
    action: "memory.export",
    target: archive.manifest.export_id,
    decision: "prepared",
  });
  expect(receipt!.meta).toEqual({
    version: 1,
    scope: "instance",
    format: "mnemic-memory-jsonl",
    schema_version: 1,
    export_id: archive.manifest.export_id,
    rows: 0,
    bytes: first.payload.length,
    sha256: archive.sha256,
  });
  expect(
    publicAuditRow({
      ...receipt!,
      id: receipt!.id as string,
      ts: String(receipt!.ts),
      actor: receipt!.actor,
      action: receipt!.action,
      target: receipt!.target,
      decision: receipt!.decision,
      meta: receipt!.meta,
    }),
  ).toMatchObject({ metadata_omitted: false });
  const second = decodeMemoryExport((await prepareMemoryExport(t.db)).payload);
  expect(second.records).toHaveLength(1);
  expect(JSON.parse(second.records[0]!.row_json).id).toBe(receipt!.id);
});
it("reads all pages and all historical versions, exact numeric text and Evidence references without mutating source", async () => {
  const projects = Array.from({ length: 19 }, () => uuidv7());
  for (const id of projects)
    await t.sql`insert into projects(id,name,meta) values(${id},'export', '{"large":9007199254740993,"ratio":0.12345678901234567890}'::jsonb)`;
  const p = projects[0]!,
    c = uuidv7(),
    m = uuidv7(),
    o = uuidv7(),
    b = uuidv7(),
    v1 = uuidv7(),
    v2 = uuidv7();
  await t.sql`insert into conversations(id,project_id,title) values(${c},${p},'source')`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${m},${c},'user','fact','2026-11-05T00:00:00.123456Z')`;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,evidence_id,assertion_intent,source_type,authority) values(${o},${p},'fact','project','db','"PG"',${m},'ASSERT','USER_EXPLICIT',60)`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,status) values(${b},${p},'project','db','deleted')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,recorded_to,source_observation_id) values(${v1},${b},'"PG"',now(),now(),now(),${o})`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,supersedes_version_id,source_observation_id) values(${v2},${b},'"SQLite"',now(),now(),${v1},${o})`;
  await t.sql`update beliefs set current_version_id=${v2} where id=${b}`;
  const vector = "[" + Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",") + "]";
  for (const version of [v1, v2])
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${version},${vector}::vector,'offline')`;
  const archive = decodeMemoryExport((await prepareMemoryExport(t.db)).payload);
  expect(archive.counts).toMatchObject({
    projects: 19,
    conversations: 1,
    messages: 1,
    observations: 1,
    beliefs: 1,
    belief_versions: 2,
    memory_embeddings: 2,
  });
  expect(
    archive.records.filter((r) => r.table === "projects").map((r) => JSON.parse(r.row_json).id),
  ).toEqual([...projects].sort());
  for (const row of archive.records) {
    const [original] =
      await t.sql`select to_jsonb(r)::text as raw from ${t.sql(row.table)} r where id=${JSON.parse(row.row_json).id}`;
    expect(row.row_json).toBe(original!.raw);
  }
  expect(archive.records[0]!.row_json).toContain("9007199254740993");
  expect(archive.records[0]!.row_json).toContain("0.12345678901234567890");
  expect(archive.records.find((r) => r.table === "messages")!.row_json).toContain(".123456");
  expect(archive.records.filter((r) => r.table === "belief_versions")).toHaveLength(2);
  expect(
    JSON.parse(archive.records.find((r) => r.table === "observations")!.row_json).evidence_id,
  ).toBe(m);
  expect(JSON.parse(archive.records.find((r) => r.table === "beliefs")!.row_json).status).toBe(
    "deleted",
  );
});
it("one repeatable snapshot survives commits between table reads and retains the original project and messages", async () => {
  const p = uuidv7(),
    c = uuidv7(),
    m = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'before')`;
  await t.sql`insert into conversations(id,project_id) values(${c},${p})`;
  let changed = false;
  const db = new Proxy(t.db, {
    get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key, target);
      return (cb: (tx: PostgresJsDatabase) => Promise<unknown>, options: unknown) =>
        target.transaction(
          async (tx) =>
            cb(
              new Proxy(tx, {
                get(inner, k) {
                  if (k !== "execute") return Reflect.get(inner, k, inner);
                  return async (...args: Parameters<typeof tx.execute>) => {
                    const result = await tx.execute(...args);
                    if (
                      !changed &&
                      result.some(
                        (r) => typeof r.row_json === "string" && JSON.parse(r.row_json).id === p,
                      )
                    ) {
                      changed = true;
                      await t.sql.begin(async (other) => {
                        await other`update projects set name='after' where id=${p}`;
                        await other`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${m},${c},'user','late',now())`;
                      });
                    }
                    return result;
                  };
                },
              }),
            ),
          options as Parameters<typeof target.transaction>[1],
        );
    },
  });
  const archive = decodeMemoryExport((await prepareMemoryExport(db)).payload);
  expect(changed).toBe(true);
  expect(JSON.parse(archive.records.find((r) => r.table === "projects")!.row_json).name).toBe(
    "before",
  );
  expect(archive.counts.messages).toBe(0);
  expect(await t.sql`select id from messages where id=${m}`).toHaveLength(1);
});
it("audit insertion failure rolls back and never returns a prepared payload", async () => {
  await t.sql`alter table audit_log add constraint export_rejected check(action <> 'memory.export') not valid`;
  try {
    await expect(prepareMemoryExport(t.db)).rejects.toThrow();
  } finally {
    await t.sql`alter table audit_log drop constraint export_rejected`;
  }
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it("oversized raw row is rejected without a receipt", async () => {
  await t.sql`insert into projects(id,name) values(${uuidv7()},${"x".repeat(MEMORY_EXPORT_LIMITS.maxLineBytes + 1)})`;
  await expect(prepareMemoryExport(t.db)).rejects.toMatchObject({ code: "EXPORT_LIMIT_EXCEEDED" });
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it("wire escaping and cumulative archive limits fail without a partial prepared audit", async () => {
  for (let i = 0; i < 22; i++)
    await t.sql`insert into projects(id,name) values(${uuidv7()},${"x".repeat(800000)})`;
  await expect(prepareMemoryExport(t.db)).rejects.toMatchObject({ code: "EXPORT_LIMIT_EXCEEDED" });
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it("row count above 10000 rejects instead of truncating", async () => {
  await t.db.execute(
    sql`insert into projects(id,name) select gen_random_uuid(),'bounded' from generate_series(1,10001)`,
  );
  await expect(prepareMemoryExport(t.db)).rejects.toMatchObject({ code: "EXPORT_LIMIT_EXCEEDED" });
  expect(await t.sql`select id from audit_log`).toEqual([]);
}, 30000);

it("raw JSON below the SQL cap can still exceed the escaped wire line cap without a receipt", async () => {
  await t.sql`insert into projects(id,name) values(${uuidv7()},${"\\".repeat(330000)})`;
  await expect(prepareMemoryExport(t.db)).rejects.toMatchObject({ code: "EXPORT_LIMIT_EXCEEDED" });
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
