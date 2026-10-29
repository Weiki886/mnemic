import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { readFeatureFlags, updateFeatureFlags } from "../src/flags/repository.js";
import { processCandidate } from "../src/gate/pipeline.js";
import * as gate from "../src/gate/gate.js";
import { retryPendingGroup } from "../src/gate/lifecycle.js";
import { createPending } from "../src/gate/pending-repository.js";
import { ingestCandidate } from "../src/ingest/ingest.js";
import { attachAuthority } from "../src/extraction/authority.js";
import { runExtractionWriteback } from "../src/chat/writeback.js";
import { createMemoryTaskHandlers } from "../src/tasks/memory-handlers.js";
import { claimTasks } from "../src/tasks/repository.js";
import { enqueueExtraction } from "../src/tasks/extraction-outbox.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { candidate, durableModels } from "./fixtures/durable-models.js";
let t: TestDb, saved: Awaited<ReturnType<typeof readFeatureFlags>>;
const models = durableModels();
beforeAll(async () => {
  t = await setupTestDb();
  saved = await readFeatureFlags(t.db);
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "write-flags",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { extraction: "extract", embedding: "embed" },
  });
}, 180000);
beforeEach(async () => {
  vi.stubEnv("MNEMIC_READ_REINFORCE", undefined);
  models.generate.mockClear();
  models.embedding.mockClear();
  models.output([candidate()]);
  await t.sql`update feature_flags set flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb,revision=0 where scope='server'`;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (t) {
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb,revision=${saved.revision} where scope='server'`;
    await t.close();
  }
});
async function configure(over: Partial<typeof DEFAULT_FEATURE_FLAGS>) {
  const now = await readFeatureFlags(t.db);
  return (
    await updateFeatureFlags(t.db, {
      expected_revision: now.revision,
      flags: { ...now.flags, ...over },
    })
  ).snapshot;
}
async function seed() {
  const p = uuidv7(),
    c = uuidv7(),
    m = uuidv7();
  await t.sql`insert into projects(id,name) values(${p},'write flags')`;
  await t.sql`insert into conversations(id,project_id) values(${c},${p})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${m},${c},'user','database decision',now())`;
  return { p, c, m };
}
async function message(f: Awaited<ReturnType<typeof seed>>) {
  const id = uuidv7();
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${id},${f.c},'user','new evidence',now())`;
  return id;
}
const fact = (over: Record<string, unknown> = {}) =>
  attachAuthority(candidate(over) as Parameters<typeof attachAuthority>[0]);
it("Gate off bypasses scoring but always redacts and audits secrets", async () => {
  const f = await seed();
  await configure({ memory_gate: false });
  const evaluate = vi.spyOn(gate, "evaluateGate");
  const priorAudits =
    await t.sql`select id from audit_log where action='redact' and target='candidate.value'`;
  const secret = "ghp_" + "A".repeat(36);
  const r = await processCandidate(
    t.db,
    f.p,
    fact({ value: secret, entities: [secret], confidence: 0.1 }),
    f.m,
  );
  expect(r.decision).toBe("WRITE");
  expect(r.scores).toBeNull();
  expect(evaluate).not.toHaveBeenCalled();
  if (r.decision === "WRITE") {
    expect(r.candidate.value).toContain("[REDACTED]");
    expect(r.candidate.entities).toEqual(["[REDACTED]"]);
    await ingestCandidate(t.db, f.p, r.candidate, f.m);
    expect(
      JSON.stringify(await t.sql`select value,entities from observations where evidence_id=${f.m}`),
    ).not.toContain(secret);
  }
  expect(await t.sql`select * from pending_candidates where evidence_id=${f.m}`).toHaveLength(0);
  const rows =
    await t.sql`select * from audit_log where action='redact' and target='candidate.value'`;
  const fresh = rows.filter((row) => !priorAudits.some((old) => old.id === row.id));
  expect(fresh).toHaveLength(1);
  expect(fresh[0]!.meta.count).toBe(1);
  expect(JSON.stringify(rows)).not.toContain(secret);
});
it("Gate enabled still rejects low confidence", async () => {
  const f = await seed();
  expect((await processCandidate(t.db, f.p, fact({ confidence: 0.1 }), f.m)).decision).toBe("SKIP");
});
it("pending retry honors Gate off without rescoring sanitized stored candidates", async () => {
  const f = await seed();
  await createPending(t.db, {
    projectId: f.p,
    candidate: fact({ confidence: 0.1 }),
    gateScores: { importance: 0.9, novelty: 1, futureUtility: 1, specificity: 1, confidence: 0.1 },
    evidenceId: f.m,
    ttlMs: 10000,
  });
  await configure({ memory_gate: false });
  const score = vi.spyOn(gate, "evaluateGate");
  const promoted = await retryPendingGroup(t.db, f.p, "queue-project", "database");
  expect(promoted).toHaveLength(1);
  expect(promoted[0]!.status).toBe("promoted");
  expect(score).not.toHaveBeenCalled();
});
it("authority off changes numerical authority comparison without rewriting source authority", async () => {
  const f = await seed();
  const first = await ingestCandidate(
    t.db,
    f.p,
    fact({ source_type: "USER_CORRECTION", value: "original", valid_time: "2026-10-01" }),
    f.m,
  );
  expect(
    (
      await ingestCandidate(
        t.db,
        f.p,
        fact({ source_type: "AGENT_INFERENCE", assertion_intent: "UPDATE", value: "MySQL" }),
        await message(f),
      )
    ).relation,
  ).toBe("weaken");
  const snapshot = await configure({ authority_resolution: false });
  const result = await ingestCandidate(
    t.db,
    f.p,
    fact({ source_type: "AGENT_INFERENCE", assertion_intent: "UPDATE", value: "SQLite" }),
    await message(f),
  );
  expect(result.relation).toBe("supersede");
  const [trace] =
    await t.sql`select flags_snapshot from resolution_traces where observation_id=${result.observationId}`;
  expect(trace!.flags_snapshot).toEqual(snapshot);
  const { buildApp } = await import("../src/app.js");
  const app = buildApp({ auth: false, db: t.db, logStream: { write: () => {} } });
  try {
    const r = await app.inject({ url: `/projects/${f.p}/beliefs/${first.beliefId}/resolutions` });
    expect(r.statusCode).toBe(200);
    expect(
      r.json().find((row: { observationId: string }) => row.observationId === result.observationId)
        .flagsSnapshot,
    ).toEqual(snapshot);
  } finally {
    await app.close();
  }

  expect(
    (await t.sql`select authority from observations where id=${result.observationId}`)[0]!
      .authority,
  ).toBe(10);
  expect(
    (
      await t.sql`select v.value from beliefs b join belief_versions v on b.current_version_id=v.id where b.id=${first.beliefId}`
    )[0]!.value,
  ).toBe("SQLite");
});
it.each(["ASSERT", "RETRACT"])(
  "authority off preserves Intent protection for automatic %s and records snapshot",
  async (intent) => {
    const f = await seed();
    await ingestCandidate(
      t.db,
      f.p,
      fact({ source_type: "USER_CORRECTION", value: "original" }),
      f.m,
    );
    const snapshot = await configure({ authority_resolution: false });
    const r = await ingestCandidate(
      t.db,
      f.p,
      fact({ source_type: "AGENT_INFERENCE", assertion_intent: intent, value: "different" }),
      await message(f),
    );
    expect(r.relation).toBeNull();
    const [trace] =
      await t.sql`select policies,flags_snapshot from resolution_traces where observation_id=${r.observationId}`;
    expect(trace!.policies.intent.action).toBe("ignore");
    expect(trace!.flags_snapshot).toEqual(snapshot);
  },
);
it("user RETRACT records the actual snapshot on its dedicated resolver branch", async () => {
  const f = await seed();
  await ingestCandidate(t.db, f.p, fact(), f.m);
  const old = await readFeatureFlags(t.db);
  const r = await ingestCandidate(
    t.db,
    f.p,
    fact({ assertion_intent: "RETRACT" }),
    await message(f),
  );
  expect(
    (
      await t.sql`select policies,flags_snapshot from resolution_traces where observation_id=${r.observationId}`
    )[0],
  ).toMatchObject({ policies: { intent: { action: "retract" } }, flags_snapshot: old });
});
it.each(["legacy", "durable"])(
  "%s extraction freezes flags before the SDK call through Gate and Resolver",
  async (mode) => {
    const f = await seed();
    await ingestCandidate(
      t.db,
      f.p,
      fact({ source_type: "USER_CORRECTION", value: "original", valid_time: "2026-10-01" }),
      f.m,
    );
    const old = await configure({ memory_gate: false, authority_resolution: false });
    models.output([
      candidate({
        source_type: "AGENT_INFERENCE",
        assertion_intent: "UPDATE",
        value: "MySQL",
        confidence: 0.1,
      }),
    ]);
    const normal = models.generate.getMockImplementation()!;
    models.generate.mockImplementationOnce(async () => {
      await configure({ memory_gate: true, authority_resolution: true });
      return normal();
    });
    const id = await message(f);
    if (mode === "legacy")
      await runExtractionWriteback(
        t.db,
        TEST_MASTER_KEY,
        { projectId: f.p, text: "new decision", evidenceId: id },
        { factory: models.factory },
      );
    else {
      await enqueueExtraction(t.db, f.p, id);
      const [task] = await claimTasks(t.db, { projectId: f.p, types: ["EXTRACT"], leaseMs: 10000 });
      await createMemoryTaskHandlers(t.db, TEST_MASTER_KEY, { factory: models.factory }).EXTRACT(
        task!,
        { signal: new AbortController().signal, checkpoint: () => {} },
      );
    }
    const observations = await t.sql`select * from observations where evidence_id=${id}`;
    expect(observations).toHaveLength(1);
    const [trace] =
      await t.sql`select flags_snapshot,relation from resolution_traces where observation_id=${observations[0]!.id}`;
    expect(trace!.relation).toBe("supersede");
    expect(trace!.flags_snapshot).toEqual(old);
    expect((await readFeatureFlags(t.db)).revision).toBe(old.revision + 1);
  },
);
it.each(["legacy", "durable"])(
  "%s rejects unsupported flags before any SDK invocation or business effect",
  async (mode) => {
    const f = await seed();
    await configure({ read_time_resolution: true });
    if (mode === "legacy")
      await expect(
        runExtractionWriteback(
          t.db,
          TEST_MASTER_KEY,
          { projectId: f.p, text: "decision", evidenceId: f.m },
          { factory: models.factory },
        ),
      ).rejects.toThrow("unsupported feature flag enabled");
    else {
      await enqueueExtraction(t.db, f.p, f.m);
      const [task] = await claimTasks(t.db, { projectId: f.p, types: ["EXTRACT"], leaseMs: 10000 });
      await expect(
        createMemoryTaskHandlers(t.db, TEST_MASTER_KEY, { factory: models.factory }).EXTRACT(
          task!,
          { signal: new AbortController().signal, checkpoint: () => {} },
        ),
      ).rejects.toThrow("unsupported feature flag enabled");
    }
    expect(models.generate).not.toHaveBeenCalled();
    expect(await t.sql`select * from observations where evidence_id=${f.m}`).toHaveLength(0);
  },
);
