import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { DEFAULT_FEATURE_FLAGS, createFeatureFlagSnapshot } from "@mnemic/shared/flags";
import { retrieve } from "../src/retrieval/search.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { setupTestDb, type TestDb } from "./db-helper.js";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
}, 60000);
afterAll(async () => {
  await t?.close();
});
afterEach(() => vi.restoreAllMocks());
const snapshot = (extra = {}) =>
  createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 7,
    flags: {
      ...DEFAULT_FEATURE_FLAGS,
      retrieval_vector: false,
      authority_resolution: false,
      read_time_resolution: true,
      ...extra,
    },
  });
const opts = (extra = {}) => ({
  fusion: { mode: "rrf", threshold: 0.001 },
  topK: 1,
  readTimeResolution: true,
  flagsSnapshot: snapshot(),
  ...extra,
});
async function fixture() {
  const p = uuidv7(),
    b = uuidv7(),
    v = uuidv7(),
    old = uuidv7(),
    next = uuidv7(),
    c = uuidv7(),
    e1 = uuidv7(),
    e2 = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'runtime replay')`;
  await t.sql`insert into conversations(id,project_id) values(${c},${p})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${e1},${c},'user','offline',now()),(${e2},${c},'user','offline',now())`;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,recorded_at,evidence_id)
 values(${old},${p},'fact','app','database','"needle PostgreSQL"','ASSERT','USER_CORRECTION',70,'2025-01-01Z',${e1}),
 (${next},${p},'fact','app','database','"SQLite private-value-sentinel"','UPDATE','PROJECT_FILE',50,'2025-02-01Z',${e2})`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,salience) values(${b},${p},'app','database','0.400')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,source_observation_id) values(${v},${b},'"needle PostgreSQL"','2025-01-01Z','2025-01-01Z',${old})`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  return { p, b, v, old, next, e1, e2 };
}
async function business(p: string) {
  const [r] = await t.sql`select
 (select jsonb_agg(to_jsonb(b) order by id) from beliefs b where project_id=${p}) as beliefs,
 (select jsonb_agg(to_jsonb(v) order by id) from belief_versions v where belief_id in(select id from beliefs where project_id=${p})) as versions,
 (select jsonb_agg(to_jsonb(o) order by id) from observations o where project_id=${p}) as observations`;
  return JSON.stringify(r);
}
it.each([
  { mode: "rrf", threshold: 0.001 },
  { mode: "weighted", threshold: 0.1, weights: { vector: 0, keyword: 1, entity: 0, time: 0 } },
])("returns alternative context separately from immutable ranked anchors %j", async (fusion) => {
  const f = await fixture();
  const before = await business(f.p);
  const execute = vi.spyOn(t.db, "execute");
  const result = await retrieve(t.db, TEST_MASTER_KEY, f.p, "needle", opts({ fusion }));
  expect(execute).toHaveBeenCalledTimes(2);
  expect(result.candidates[0]).toMatchObject({ beliefVersionId: f.v, value: "needle PostgreSQL" });
  expect(result.readTimeContext?.text).toBe('[1] app / database = "SQLite private-value-sentinel"');
  expect(result.readTimeContext?.memories[0]?.provenance).toMatchObject({
    anchorVersionId: f.v,
    observationId: f.next,
    evidenceId: f.e2,
  });
  expect(result.readTimeContext?.memories[0]?.provenance.evidenceId).not.toBe(f.e1);
  const [trace] = await t.sql`select * from retrieval_traces where id=${result.traceId}`;
  expect(trace?.flags_snapshot).toMatchObject({
    revision: 7,
    flags: { read_time_resolution: true },
  });
  expect(trace?.candidates[0].readTimeResolution).toMatchObject({
    status: "selected",
    observationId: f.next,
    evidenceId: f.e2,
  });
  expect(trace?.candidates[0].readTimeResolution.decisions).toHaveLength(2);
  expect(JSON.stringify(trace?.candidates)).not.toMatch(
    /SQLite|PostgreSQL|private-value-sentinel|database|subject/,
  );
  expect(await business(f.p)).toBe(before);
});
it("flag-off skips history and keeps the legacy result and trace shape", async () => {
  const f = await fixture();
  const execute = vi.spyOn(t.db, "execute");
  const result = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    f.p,
    "needle",
    opts({ flagsSnapshot: snapshot({ read_time_resolution: false }) }),
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result).not.toHaveProperty("readTimeContext");
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${result.traceId}`;
  expect(trace?.candidates[0]).not.toHaveProperty("readTimeResolution");
});
it("retraction abstains only the resolved context, retaining explicit anchor scoring semantics", async () => {
  const f = await fixture();
  await t.sql`update observations set assertion_intent='RETRACT',source_type='USER_EXPLICIT' where id=${f.next}`;
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "needle", opts());
  expect(r.abstained).toBe(false);
  expect(r.candidates).toHaveLength(1);
  expect(r.readTimeContext?.abstained).toBe(true);
  expect(r.readTimeContext?.memories).toEqual([]);
  const [trace] = await t.sql`select candidates from retrieval_traces where id=${r.traceId}`;
  expect(trace?.candidates[0].readTimeResolution).toMatchObject({
    status: "unselected",
    observationId: null,
    evidenceId: null,
  });
});
it("empty or below-threshold anchor pools produce empty context without a history query", async () => {
  const f = await fixture();
  const execute = vi.spyOn(t.db, "execute");
  const r = await retrieve(t.db, TEST_MASTER_KEY, f.p, "unmatched", opts());
  expect(execute).toHaveBeenCalledTimes(1);
  expect(r.readTimeContext?.abstained).toBe(true);
  expect(r.readTimeContext?.outcomes).toEqual([]);
});
it("the trusted binding is required even for an explicit enabled snapshot", async () => {
  const f = await fixture();
  await expect(
    retrieve(t.db, TEST_MASTER_KEY, f.p, "needle", opts({ readTimeResolution: false })),
  ).rejects.toThrow("unsupported feature flag enabled");
});
it.each([
  { readTimeResolution: null },
  { readTimeResolution: 0 },
  { flagsSnapshot: undefined },
  { topK: 33 },
  { fusion: undefined },
  { memoryBudget: { maxTokens: 100, countTokens: () => 0 } },
  { reinforce: true },
  { flagsSnapshot: snapshot({ read_time_reinforcement: true }) },
])("invalid binding or unsupported combination rejects before DB %j", async (extra) => {
  const reads = vi.fn(() => {
    throw Error("unexpected DB");
  });
  const db = new Proxy(t.db, { get: reads });
  await expect(retrieve(db, TEST_MASTER_KEY, uuidv7(), "needle", opts(extra))).rejects.toThrow(
    "INVALID_READ_TIME_RETRIEVAL_OPTIONS",
  );
  expect(reads).not.toHaveBeenCalled();
});
it("corrupt replay history fails before any retrieval trace is inserted", async () => {
  const f = await fixture();
  const foreign = await fixture();
  await t.sql`update observations set evidence_id=${foreign.e2} where id=${f.next}`;
  await expect(retrieve(t.db, TEST_MASTER_KEY, f.p, "needle", opts())).rejects.toThrow(
    "INVALID_READ_TIME_HISTORY",
  );
  const [n] = await t.sql`select count(*) as n from retrieval_traces where project_id=${f.p}`;
  expect(n?.n).toBe("0");
});
it("closed routes still reject an enabled snapshot without invoking the experiment", async () => {
  const f = await fixture();
  await expect(
    retrieve(t.db, TEST_MASTER_KEY, f.p, "needle", opts({ readTimeResolution: undefined })),
  ).rejects.toThrow("unsupported feature flag enabled");
});
it("freezes the effective snapshot before its first asynchronous boundary", async () => {
  const f = await fixture();
  const mutable = JSON.parse(JSON.stringify(snapshot()));
  const options = opts({ flagsSnapshot: mutable });
  const pending = retrieve(t.db, TEST_MASTER_KEY, f.p, "needle", options);
  mutable.flags.read_time_resolution = false;
  mutable.flags.authority_resolution = true;
  mutable.revision = 99;
  options.readTimeResolution = false;
  const r = await pending;
  expect(r.readTimeContext?.memories[0]?.provenance.observationId).toBe(f.next);
  const [trace] = await t.sql`select flags_snapshot from retrieval_traces where id=${r.traceId}`;
  expect(trace?.flags_snapshot).toMatchObject({
    revision: 7,
    flags: { read_time_resolution: true, authority_resolution: false },
  });
});
it("observed cancellation refuses the context and creates no partial trace", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = retrieve(
    t.db,
    TEST_MASTER_KEY,
    f.p,
    "needle",
    opts({ signal: controller.signal }),
  );
  controller.abort("private-cancel-sentinel");
  await expect(pending).rejects.toThrow(new Error("READ_TIME_CONTEXT_ABORTED"));
  const [row] = await t.sql`select count(*) as n from retrieval_traces where project_id=${f.p}`;
  expect(row?.n).toBe("0");
});
