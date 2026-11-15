import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { readReadTimeReplay } from "../src/retrieval/read-time-history.js";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
}, 60000);
afterAll(async () => {
  await t?.close();
});
async function fixture() {
  const projectId = uuidv7(),
    beliefId = uuidv7(),
    beliefVersionId = uuidv7();
  const conversationId = uuidv7(),
    evidenceId = uuidv7(),
    observationId = uuidv7();
  await t.sql`insert into projects(id,name) values(${projectId},'replay')`;
  await t.sql`insert into conversations(id,project_id) values(${conversationId},${projectId})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${evidenceId},${conversationId},'user','offline',now())`;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,valid_time,recorded_at,evidence_id)
    values(${observationId},${projectId},'fact','app','database','"PostgreSQL"','ASSERT','USER_EXPLICIT',60,'2025-01-01Z','2025-01-02Z',${evidenceId})`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute) values(${beliefId},${projectId},'app','database')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,source_observation_id,resolver_version)
    values(${beliefVersionId},${beliefId},'"PostgreSQL"','2025-01-01Z',now(),${observationId},'offline')`;
  await t.sql`update beliefs set current_version_id=${beliefVersionId} where id=${beliefId}`;
  return {
    projectId,
    beliefId,
    beliefVersionId,
    evidenceId,
    observationId,
    authorityEnabled: true,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;
const scope = (f: F) => ({
  projectId: f.projectId,
  beliefId: f.beliefId,
  beliefVersionId: f.beliefVersionId,
  authorityEnabled: f.authorityEnabled,
});
async function incoming(f: F, recordedAt = "2025-02-02T00:00:00Z") {
  const id = uuidv7();
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,valid_time,recorded_at,evidence_id)
    values(${id},${f.projectId},'fact','app','database','"SQLite"','UPDATE','PROJECT_FILE',50,'2025-02-01Z',${recordedAt},${f.evidenceId})`;
  return id;
}
async function snapshot(f: F) {
  const rows = await t.sql`select to_jsonb(b) as belief,
    (select jsonb_agg(to_jsonb(v) order by id) from belief_versions v where v.belief_id=b.id) as versions,
    (select jsonb_agg(to_jsonb(o) order by id) from observations o where o.project_id=b.project_id) as observations,
    (select count(*) from resolution_traces r where r.project_id=b.project_id) as resolutions,
    (select count(*) from retrieval_traces r where r.project_id=b.project_id) as retrievals
    from beliefs b where b.id=${f.beliefId}`;
  return JSON.stringify(rows);
}
it("replays actual same-group history without touching any business row or trace", async () => {
  const f = await fixture();
  const id = await incoming(f);
  const before = await snapshot(f);
  const keep = await readReadTimeReplay(t.db, scope(f));
  expect(keep?.selected?.value).toBe("PostgreSQL");
  const ablated = await readReadTimeReplay(t.db, { ...scope(f), authorityEnabled: false });
  expect(ablated?.selected).toMatchObject({
    observationId: id,
    evidenceId: f.evidenceId,
    value: "SQLite",
  });
  expect(ablated?.anchorVersionId).toBe(f.beliefVersionId);
  expect(ablated?.decisions[1]?.relation).toBe("supersede");
  expect(await snapshot(f)).toBe(before);
});
it.each(["deleted", "retracted", "expired"])(
  "%s anchors never produce a result",
  async (status) => {
    const f = await fixture();
    await t.sql`update beliefs set status=${status} where id=${f.beliefId}`;
    expect(await readReadTimeReplay(t.db, scope(f))).toBeNull();
  },
);
it("cross-project, wrong-current and closed versions cannot anchor replay", async () => {
  const f = await fixture();
  const other = await fixture();
  expect(await readReadTimeReplay(t.db, { ...scope(f), projectId: other.projectId })).toBeNull();
  expect(await readReadTimeReplay(t.db, { ...scope(f), beliefVersionId: uuidv7() })).toBeNull();
  await t.sql`update belief_versions set recorded_to=now() where id=${f.beliefVersionId}`;
  expect(await readReadTimeReplay(t.db, scope(f))).toBeNull();
});
it("ignores other groups and projects, but rejects corrupt same-group Evidence ownership", async () => {
  const f = await fixture();
  const other = await fixture();
  await incoming(other);
  const differentAttribute = await incoming(f);
  await t.sql`update observations set attribute='unrelated' where id=${differentAttribute}`;
  expect((await readReadTimeReplay(t.db, scope(f)))?.decisions).toHaveLength(1);
  const bad = await incoming(f);
  await t.sql`update observations set evidence_id=${other.evidenceId} where id=${bad}`;
  await expect(readReadTimeReplay(t.db, scope(f))).rejects.toThrow("INVALID_READ_TIME_HISTORY");
});
it("does not trust an anchor source pointing into another project", async () => {
  const f = await fixture();
  const other = await fixture();
  await t.sql`update belief_versions set source_observation_id=${other.observationId} where id=${f.beliefVersionId}`;
  expect(await readReadTimeReplay(t.db, scope(f))).toBeNull();
});
it("200 events are complete; 201 rejects instead of silently replaying a prefix", async () => {
  const f = await fixture();
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,recorded_at,evidence_id)
    select gen_random_uuid(),${f.projectId},'fact','app','database','"PostgreSQL"','ASSERT','USER_EXPLICIT',60,'2025-02-01Z',${f.evidenceId}
    from generate_series(1,199)`;
  expect((await readReadTimeReplay(t.db, scope(f)))?.decisions).toHaveLength(200);
  await incoming(f);
  await expect(readReadTimeReplay(t.db, scope(f))).rejects.toThrow("INVALID_READ_TIME_HISTORY");
});
it("chronology retains PG microseconds even when UUID order differs", async () => {
  const f = await fixture();
  const late = await incoming(f, "2025-02-02T00:00:00.000002Z");
  const early = await incoming(f, "2025-02-02T00:00:00.000001Z");
  expect(early > late).toBe(true);
  const r = await readReadTimeReplay(t.db, scope(f));
  expect(r?.decisions.map((d) => d.observationId)).toEqual([f.observationId, early, late]);
});
it("oversized values fail closed without exposing them", async () => {
  const f = await fixture();
  await t.sql`update observations set value=to_jsonb(${"private-sentinel".repeat(2000)}::text) where id=${f.observationId}`;
  await expect(readReadTimeReplay(t.db, scope(f))).rejects.toThrow("INVALID_READ_TIME_HISTORY");
});
it("scope and captured authority switch are copied before the first DB await", async () => {
  const f = await fixture();
  await incoming(f);
  const input = { ...scope(f), authorityEnabled: false };
  const pending = readReadTimeReplay(t.db, input);
  input.authorityEnabled = true;
  input.projectId = uuidv7();
  expect((await pending)?.selected?.value).toBe("SQLite");
});
it("invalid scope rejects before DB access, DB failures never expose raw errors", async () => {
  const execute = vi.fn(() => {
    throw Error("private-sentinel");
  });
  const db = { execute } as unknown as typeof t.db;
  await expect(readReadTimeReplay(db, { projectId: "bad" })).rejects.toThrow(
    "INVALID_READ_TIME_SCOPE",
  );
  expect(execute).not.toHaveBeenCalled();
  const f = await fixture();
  await expect(readReadTimeReplay(db, scope(f))).rejects.toThrow("READ_TIME_HISTORY_FAILED");
});
