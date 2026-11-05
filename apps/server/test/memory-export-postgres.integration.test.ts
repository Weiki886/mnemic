import { beforeAll, afterAll, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { encodeMemoryExport, decodeMemoryExport } from "../src/data-export/codec.js";
import {
  MEMORY_EXPORT_TABLES,
  type ExportTable,
  type ExportRecord,
} from "../src/data-export/format.js";
const project = uuidv7(),
  conversation = uuidv7(),
  message = uuidv7(),
  belief = uuidv7();
const observation1 = uuidv7(),
  observation2 = uuidv7(),
  v1 = uuidv7(),
  v2 = uuidv7(),
  e1 = uuidv7(),
  e2 = uuidv7(),
  audit = uuidv7();
const ids: Record<ExportTable, string[]> = {
  projects: [project],
  conversations: [conversation],
  messages: [message],
  observations: [observation1, observation2],
  beliefs: [belief],
  belief_versions: [v1, v2],
  memory_embeddings: [e1, e2],
  audit_log: [audit],
};
const bigValue =
  '{"database":"PostgreSQL","budget":9007199254740993,"ratio":0.12345678901234567890,"nested":[null,true]}';
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name,created_at,meta) values(${project},'export-raw','2026-11-05T00:00:00.123456Z',${bigValue}::jsonb)`;
  await t.sql`insert into conversations(id,project_id,title,started_at,meta) values(${conversation},${project},null,'2026-11-05T00:00:00.123456Z','{"resume":null}'::jsonb)`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time,memories,attachment) values(${message},${conversation},'user',${'line one\n中文 "quoted" 😀'},'2026-11-05T00:00:00.123456Z',null,null)`;
  for (const [id, source, authority, value] of [
    [observation1, "USER_EXPLICIT", 60, bigValue],
    [observation2, "USER_CORRECTION", 70, "null"],
  ] as const)
    await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,evidence_id,valid_time,recorded_at,entities,confidence) values(${id},${project},'decision','export-project','database',${value}::jsonb,'ASSERT',${source},${authority},${message},null,'2026-11-05T00:00:00.123456Z','[]'::jsonb,0.875)`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,evidence_count,confidence,salience,importance) values(${belief},${project},'export-project','database',2,0.875,0,1)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,valid_to,recorded_from,recorded_to,source_observation_id,confidence) values(${v1},${belief},${bigValue}::jsonb,'2026-11-01T00:00:00.111111Z','2026-11-05T00:00:01.654321Z','2026-11-05T00:00:00.123456Z','2026-11-05T00:00:01.654321Z',${observation1},0.875)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,supersedes_version_id,source_observation_id,confidence) values(${v2},${belief},'null'::jsonb,'2026-11-05T00:00:01.654321Z','2026-11-05T00:00:01.654321Z',${v1},${observation2},1)`;
  await t.sql`update beliefs set current_version_id=${v2} where id=${belief}`;
  const vector = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  for (const [id, version] of [
    [e1, v1],
    [e2, v2],
  ])
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${id!},${version!},${vector}::vector,'offline-export-1024')`;
  await t.sql`insert into audit_log(id,ts,actor,action,target,decision,meta) values(${audit},'2026-11-05T00:00:00.123456Z','fixture','unknown.history',null,null,${bigValue}::jsonb)`;
}, 180000);
afterAll(async () => {
  if (t)
    try {
      await t.sql`delete from audit_log where id=${audit}`;
      await t.sql`delete from memory_embeddings where belief_version_id in (${v1},${v2})`;
      await t.sql`update beliefs set current_version_id=null where id=${belief}`;
      await t.sql`delete from belief_versions where belief_id=${belief}`;
      await t.sql`delete from beliefs where id=${belief}`;
      await t.sql`delete from observations where id in (${observation1},${observation2})`;
      await t.sql`delete from messages where id=${message}`;
      await t.sql`delete from conversations where id=${conversation}`;
      await t.sql`delete from projects where id=${project}`;
    } finally {
      await t.close();
    }
});
async function sourceRows(): Promise<ExportRecord[]> {
  const rows: ExportRecord[] = [];
  for (const table of MEMORY_EXPORT_TABLES) {
    const found =
      await t.sql`select to_jsonb(r)::text as raw from ${t.sql(table)} r where id in ${t.sql(ids[table])} order by id`;
    for (const row of found) rows.push({ table, row_json: row.raw as string });
  }
  return rows;
}
it("all eight core tables preserve complete raw PG rows through JSONL and typed PostgreSQL reconstruction", async () => {
  const original = await sourceRows();
  expect(original).toHaveLength(11);
  const archive = encodeMemoryExport({
    export_id: uuidv7(),
    created_at: "2026-11-05T00:00:00.123456Z",
    records: original,
  });
  const decoded = decodeMemoryExport(archive);
  expect(decoded.records).toEqual(original);
  for (const row of decoded.records) {
    // Identifier comes only from the fixed table enum; row text is a bound JSONB value.
    // SELECT reconstructs a composite value, without writing any row or implementing an importer.
    const [restored] =
      await t.sql`select to_jsonb(jsonb_populate_record(null::${t.sql(row.table)},${row.row_json}::jsonb))::text as raw`;
    expect(restored!.raw).toBe(row.row_json);
  }
  expect(
    decoded.records.find((r) => r.table === "belief_versions" && JSON.parse(r.row_json).id === v1)!
      .row_json,
  ).toContain("9007199254740993");
  expect(
    decoded.records.find((r) => r.table === "belief_versions" && JSON.parse(r.row_json).id === v1)!
      .row_json,
  ).toContain("0.12345678901234567890");
  expect(decoded.records.find((r) => r.table === "messages")!.row_json).toContain(".123456");
  expect(await sourceRows()).toEqual(original);
});
it("keeps every version, current/supersedes/source/Evidence reference and unknown audit metadata intact", async () => {
  const decoded = decodeMemoryExport(
    encodeMemoryExport({
      export_id: uuidv7(),
      created_at: new Date().toISOString(),
      records: await sourceRows(),
    }),
  );
  const versions = decoded.records
    .filter((r) => r.table === "belief_versions")
    .map((r) => JSON.parse(r.row_json));
  expect(versions).toHaveLength(2);
  expect(versions.find((v) => v.id === v1)).toMatchObject({
    source_observation_id: observation1,
    recorded_to: expect.stringMatching(/\.654321(?:Z|[+-]\d\d:\d\d)$/),
  });
  expect(Date.parse(versions.find((v) => v.id === v1).recorded_to)).toBe(
    Date.parse("2026-11-05T00:00:01.654321Z"),
  );
  expect(versions.find((v) => v.id === v2)).toMatchObject({
    value: null,
    supersedes_version_id: v1,
    source_observation_id: observation2,
    recorded_to: null,
  });
  expect(JSON.parse(decoded.records.find((r) => r.table === "beliefs")!.row_json)).toMatchObject({
    current_version_id: v2,
    evidence_count: 2,
    confidence: 0.875,
    salience: 0,
    importance: 1,
  });
  for (const row of decoded.records.filter((r) => r.table === "observations"))
    expect(JSON.parse(row.row_json).evidence_id).toBe(message);
  expect(decoded.records.find((r) => r.table === "audit_log")!.row_json).toContain(
    "9007199254740993",
  );
  expect(decoded.counts).toEqual({
    projects: 1,
    conversations: 1,
    messages: 1,
    observations: 2,
    beliefs: 1,
    belief_versions: 2,
    memory_embeddings: 2,
    audit_log: 1,
  });
});
