import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { buildReadTimeContext } from "../src/retrieval/read-time-context.js";
import { renderMemoryContext, memoryContent } from "../src/retrieval/context-budget.js";

let t: TestDb;
afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
}, 60000);
afterAll(async () => {
  await t?.close();
});
async function fixture(
  value: unknown = "PostgreSQL",
  attribute = "database",
  existingProject?: string,
) {
  const projectId = existingProject ?? uuidv7(),
    beliefId = uuidv7(),
    versionId = uuidv7(),
    observationId = uuidv7(),
    evidenceId = uuidv7(),
    conversationId = uuidv7();
  if (!existingProject) await t.sql`insert into projects(id,name) values(${projectId},'context')`;
  await t.sql`insert into conversations(id,project_id) values(${conversationId},${projectId})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${evidenceId},${conversationId},'user','offline',now())`;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,evidence_id,recorded_at)
    values(${observationId},${projectId},'fact','app',${attribute},${JSON.stringify(value)}::jsonb,'ASSERT','USER_EXPLICIT',60,${evidenceId},'2025-01-01Z')`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,current_version_id) values(${beliefId},${projectId},'app',${attribute},null)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,source_observation_id)
    values(${versionId},${beliefId},${JSON.stringify(value)}::jsonb,'2025-01-01Z','2025-01-01Z',${observationId})`;
  await t.sql`update beliefs set current_version_id=${versionId} where id=${beliefId}`;
  return { projectId, beliefId, beliefVersionId: versionId, observationId, evidenceId, attribute };
}
type F = Awaited<ReturnType<typeof fixture>>;
const anchor = (f: F) => ({ beliefId: f.beliefId, beliefVersionId: f.beliefVersionId });
const scope = (f: F, anchors = [anchor(f)]) => ({
  projectId: f.projectId,
  anchors,
  authorityEnabled: false,
});
async function update(f: F, value: unknown, intent = "UPDATE") {
  const id = uuidv7();
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,evidence_id,recorded_at)
    values(${id},${f.projectId},'fact','app',${f.attribute},${JSON.stringify(value)}::jsonb,${intent},'USER_EXPLICIT',60,${f.evidenceId},'2025-02-01Z')`;
  return id;
}
it("renders the replay value with actual Evidence provenance, never under the anchor version identity", async () => {
  const f = await fixture();
  const id = await update(f, "SQLite");
  const execute = vi.spyOn(t.db, "execute");
  const result = await buildReadTimeContext(t.db, scope(f));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.text).toBe('[1] app / database = "SQLite"');
  expect(result.memories[0]).toEqual({
    subject: "app",
    attribute: "database",
    value: "SQLite",
    provenance: {
      kind: "observation_replay",
      projectId: f.projectId,
      beliefId: f.beliefId,
      anchorVersionId: f.beliefVersionId,
      observationId: id,
      evidenceId: f.evidenceId,
      validFrom: "2025-02-01T00:00:00.000Z",
    },
  });
  expect(result.memories[0]).not.toHaveProperty("beliefVersionId");
  expect(result.abstained).toBe(false);
  const [row] = await t.sql`select value from belief_versions where id=${f.beliefVersionId}`;
  expect(row?.value).toBe("PostgreSQL");
  const [counts] =
    await t.sql`select (select count(*) from retrieval_traces where project_id=${f.projectId}) as retrievals,(select count(*) from resolution_traces where project_id=${f.projectId}) as resolutions`;
  expect(counts).toEqual({ retrievals: "0", resolutions: "0" });
});
it("shares the canonical numbered memory renderer and keeps metadata free of values and labels", async () => {
  const f = await fixture("private-value-sentinel");
  const result = await buildReadTimeContext(t.db, scope(f));
  expect(result.text).toBe(renderMemoryContext(result.memories.map(memoryContent)));
  expect(JSON.stringify(result.outcomes)).not.toMatch(
    /private-value-sentinel|database|subject|value/,
  );
});
it("filters retracted and missing anchors while renumbering selected memories", async () => {
  const a = await fixture();
  const b = await fixture("Redis", "cache", a.projectId);
  await update(a, "PostgreSQL", "RETRACT");
  const absent = { beliefId: uuidv7(), beliefVersionId: uuidv7() };
  const result = await buildReadTimeContext(t.db, scope(a, [anchor(a), absent, anchor(b)]));
  expect(result.outcomes.map((o) => o.status)).toEqual(["unselected", "unavailable", "selected"]);
  expect(result.text).toBe('[1] app / cache = "Redis"');
});
it("a selected JSON null remains a fact rather than a retraction", async () => {
  const f = await fixture(null);
  const r = await buildReadTimeContext(t.db, scope(f));
  expect(r.text).toBe("[1] app / database = null");
  expect(r.abstained).toBe(false);
});
it("an ignored-only history is unselected, not a fabricated retraction", async () => {
  const f = await fixture();
  await t.sql`update observations set assertion_intent='RETRACT',source_type='AGENT_INFERENCE',authority=10 where id=${f.observationId}`;
  const result = await buildReadTimeContext(t.db, scope(f));
  expect(result.outcomes[0]?.status).toBe("unselected");
  expect(result.outcomes[0]?.decisions[0]?.action).toBe("ignore");
  expect(result.abstained).toBe(true);
});
it("empty batches do not touch the database and render the canonical empty marker", async () => {
  const execute = vi.fn();
  const r = await buildReadTimeContext(
    { execute },
    { projectId: uuidv7(), anchors: [], authorityEnabled: true },
  );
  expect(r.text).toBe(renderMemoryContext([]));
  expect(r.abstained).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
it("does not accept caller-supplied display fields", async () => {
  const execute = vi.fn();
  await expect(
    buildReadTimeContext(
      { execute },
      { projectId: uuidv7(), anchors: [], authorityEnabled: true, value: "spoof" },
    ),
  ).rejects.toThrow("INVALID_READ_TIME_SCOPE");
  expect(execute).not.toHaveBeenCalled();
});
it("entry cancellation rejects before SQL without echoing its reason", async () => {
  const c = new AbortController();
  c.abort("private-cancel-sentinel");
  const execute = vi.fn();
  await expect(buildReadTimeContext({ execute }, {}, c.signal)).rejects.toThrow(
    new Error("READ_TIME_CONTEXT_ABORTED"),
  );
  expect(execute).not.toHaveBeenCalled();
});
it("observed cancellation after SQL rejects the complete context", async () => {
  const f = await fixture();
  const c = new AbortController();
  const pending = buildReadTimeContext(t.db, scope(f), c.signal);
  c.abort("private-cancel-sentinel");
  await expect(pending).rejects.toThrow(new Error("READ_TIME_CONTEXT_ABORTED"));
});
it("captures scope before awaiting the source", async () => {
  const f = await fixture();
  await update(f, "SQLite");
  const input = scope(f);
  const pending = buildReadTimeContext(t.db, input);
  input.authorityEnabled = true;
  input.anchors[0]!.beliefId = uuidv7();
  expect((await pending).text).toContain('"SQLite"');
});
it("rejects an oversized rendered entry instead of truncating or returning a partial context", async () => {
  const f = await fixture("x".repeat(16375));
  await expect(buildReadTimeContext(t.db, scope(f))).rejects.toThrow(
    new Error("READ_TIME_CONTEXT_TOO_LARGE"),
  );
});
it("rejects a combined block over 64KiB even when each entry fits", async () => {
  const first = await fixture("x".repeat(14000));
  const anchors = [anchor(first)];
  for (let i = 0; i < 4; i++)
    anchors.push(anchor(await fixture("x".repeat(14000), "key" + i, first.projectId)));
  await expect(buildReadTimeContext(t.db, scope(first, anchors))).rejects.toThrow(
    new Error("READ_TIME_CONTEXT_TOO_LARGE"),
  );
});
it("allows an entry exactly at 16KiB and counts UTF-8 rather than characters", async () => {
  const overhead = Buffer.byteLength(
    memoryContent({ subject: "app", attribute: "database", value: "" }),
    "utf8",
  );
  const f = await fixture("x".repeat(16384 - overhead));
  expect(
    Buffer.byteLength(
      memoryContent((await buildReadTimeContext(t.db, scope(f))).memories[0]!),
      "utf8",
    ),
  ).toBe(16384);
  const wide = await fixture("界".repeat(5460));
  await expect(buildReadTimeContext(t.db, scope(wide))).rejects.toThrow(
    new Error("READ_TIME_CONTEXT_TOO_LARGE"),
  );
});
it("includes numbering and separators in the exact 64KiB block boundary", async () => {
  const f = await fixture("", "key0");
  const anchors = [anchor(f)];
  for (let i = 0; i < 4; i++) {
    const item = i === 0 ? f : await fixture("", "key" + i, f.projectId);
    if (i > 0) anchors.push(anchor(item));
    const target = i === 3 ? 16380 : 16379;
    const overhead = Buffer.byteLength(
      memoryContent({ subject: "app", attribute: item.attribute, value: "" }),
      "utf8",
    );
    await update(item, "x".repeat(target - overhead));
  }
  const result = await buildReadTimeContext(t.db, scope(f, anchors));
  expect(Buffer.byteLength(result.text, "utf8")).toBe(65536);
  await t.sql`update observations set value=to_jsonb((value #>> '{}') || 'x') where id=${result.memories[0]!.provenance.observationId}`;
  await expect(buildReadTimeContext(t.db, scope(f, anchors))).rejects.toThrow(
    new Error("READ_TIME_CONTEXT_TOO_LARGE"),
  );
});
