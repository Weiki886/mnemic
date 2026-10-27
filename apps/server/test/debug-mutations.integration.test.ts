import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { createDebugTrace } from "../src/debug/trace.js";
import { createPending } from "../src/gate/pending-repository.js";
import { expirePending, retryPendingGroup } from "../src/gate/lifecycle.js";
import { parseDebugLine } from "@mnemic/shared/debug";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
const secret = "sk-debugmutation01234567890123456789",
  token = "debug-mutations-test-token-0123456789";
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
async function fixture(debugMode = true) {
  const p = uuidv7(),
    c = uuidv7(),
    evidence = uuidv7(),
    belief = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'debug-mutation')`;
  await t.sql`insert into conversations(id,project_id) values(${c},${p})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${evidence},${c},'user',${secret},now())`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,confidence) values(${belief},${p},'private-subject','database',0.8)`;
  let log = "";
  const app = buildApp({
    db: t.db,
    authToken: token,
    debugMode,
    logStream: {
      write: (s) => {
        log += s;
      },
    },
  });
  const post = (url: string, payload?: object) =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  const rows = () =>
    log
      .split("\n")
      .filter(Boolean)
      .map(parseDebugLine)
      .filter((r) => r !== null);
  const pending = (ttlMs = 60000) =>
    createPending(t.db, {
      projectId: p,
      evidenceId: evidence,
      ttlMs,
      gateScores: {},
      candidate: {
        type: "decision",
        subject: "my-project",
        attribute: "cache",
        value: secret,
        valid_time: "2026-09-01",
        time_precision: "DAY",
        time_confidence: 0.95,
        assertion_intent: "ASSERT",
        source_type: "USER_EXPLICIT",
        importance: 0.9,
        confidence: 0.5,
        entities: ["my-project", "Redis"],
        is_profile: true,
        authority: 60,
        reliability: 0.95,
      },
    });
  return { p, c, evidence, belief, app, post, rows, log: () => log, pending };
}
it("records correction only after the outer transaction commits, using real provenance references", async () => {
  const f = await fixture();
  try {
    const res = await f.post(`/projects/${f.p}/beliefs/${f.belief}/correct`, { value: secret });
    expect(res.statusCode).toBe(200);
    const rows = f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "memory.belief.corrected",
      target_id: f.belief,
      detail: { project_id: f.p, route: "conflict", relation: "supersede" },
    });
    const detail = rows[0]!.detail;
    expect("observation_id" in detail).toBe(true);
    if (!("observation_id" in detail)) throw Error("missing reference");
    const [obs] =
      await t.sql`select o.id,m.conversation_id from observations o join messages m on m.id=o.evidence_id where o.id=${detail.observation_id!}`;
    expect(obs).toBeDefined();
    expect("conversation_id" in detail && detail.conversation_id).toBe(obs!.conversation_id);
    expect(f.log()).not.toContain(secret);
    expect(f.log()).not.toContain("private-subject");
  } finally {
    await f.app.close();
  }
});
it("emits delete/restore exactly once after conditional updates; rejects do not pretend success", async () => {
  const f = await fixture();
  try {
    const path = `/projects/${f.p}/beliefs/${f.belief}`;
    expect((await f.post(path + "/delete")).statusCode).toBe(200);
    expect((await f.post(path + "/delete")).statusCode).toBe(409);
    expect((await f.post(path + "/correct", { value: "forbidden" })).statusCode).toBe(409);
    expect((await f.post(path + "/restore")).statusCode).toBe(200);
    expect(f.rows().map((r) => r.detail)).toEqual([
      { project_id: f.p, status: "deleted" },
      { project_id: f.p, status: "active" },
    ]);
    expect(
      f.rows().every((r) => r.event === "memory.belief.status_changed" && r.target_id === f.belief),
    ).toBe(true);
  } finally {
    await f.app.close();
  }
});
it("has no successful mutation records on rollback, cross-project, missing or unauthenticated requests", async () => {
  const f = await fixture(),
    other = uuidv7();
  try {
    expect(
      (await f.post(`/projects/${other}/beliefs/${f.belief}/correct`, { value: secret }))
        .statusCode,
    ).toBe(404);
    expect((await f.post(`/projects/${other}/beliefs/${f.belief}/delete`)).statusCode).toBe(404);
    expect(
      (await f.app.inject({ method: "POST", url: `/projects/${f.p}/beliefs/${f.belief}/delete` }))
        .statusCode,
    ).toBe(401);
    const transaction = t.db.transaction.bind(t.db);
    const spy = vi.spyOn(t.db, "transaction").mockImplementationOnce((fn, config) =>
      transaction(async (tx) => {
        await fn(tx);
        throw new Error(secret); // Real PG rolls back after the successful nested ingest/savepoint.
      }, config),
    );
    try {
      const failure = await f.post(`/projects/${f.p}/beliefs/${f.belief}/correct`, {
        value: secret,
      });
      expect(failure.statusCode).toBe(500);
      expect(await t.sql`select id from observations where project_id=${f.p}`).toHaveLength(0);
      expect(await t.sql`select id from resolution_traces where project_id=${f.p}`).toHaveLength(0);
      expect(f.rows()).toEqual([]);
      expect(f.log()).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await f.app.close();
  }
});
it.each(["confirm", "reject"])(
  "records pending %s with project/Evidence from the stored row, no candidate body",
  async (action) => {
    const f = await fixture();
    try {
      const pending = await f.pending();
      expect((await f.post(`/pending/${pending.id}/${action}`)).statusCode).toBe(200);
      expect(f.rows()).toEqual([
        expect.objectContaining({
          event: "memory.pending.decided",
          target_id: pending.id,
          detail: {
            project_id: f.p,
            evidence_id: f.evidence,
            status: action === "confirm" ? "confirmed" : "rejected",
          },
        }),
      ]);
      expect(f.log()).not.toContain(secret);
    } finally {
      await f.app.close();
    }
  },
);
it("explicit lifecycle sinks record promoted/expired after writes without dumping candidate JSON", async () => {
  const f = await fixture();
  try {
    const promoted = await f.pending();
    const trace = createDebugTrace(f.app.log);
    await retryPendingGroup(t.db, f.p, "my-project", "cache", trace);
    const expired = await f.pending(-1000);
    await expirePending(t.db, new Date(), trace);
    expect(f.rows()).toContainEqual(
      expect.objectContaining({
        event: "memory.pending.decided",
        target_id: promoted.id,
        detail: { project_id: f.p, evidence_id: f.evidence, status: "promoted" },
      }),
    );
    expect(f.rows()).toContainEqual(
      expect.objectContaining({
        event: "memory.pending.decided",
        target_id: expired.id,
        detail: { project_id: f.p, evidence_id: f.evidence, status: "expired" },
      }),
    );
    expect(f.log()).not.toContain(secret);
  } finally {
    await f.app.close();
  }
});
it("metadata off stays silent for correction, deletion, restoration and pending confirmation", async () => {
  const f = await fixture(false);
  try {
    const path = `/projects/${f.p}/beliefs/${f.belief}`;
    await f.post(path + "/correct", { value: secret });
    await f.post(path + "/delete");
    await f.post(path + "/restore");
    const pending = await f.pending();
    await f.post(`/pending/${pending.id}/confirm`);
    expect(f.rows()).toEqual([]);
    expect(f.log()).not.toContain(secret);
  } finally {
    await f.app.close();
  }
});
