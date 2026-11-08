import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { uuidv7 } from "uuidv7";
import { Ajv } from "ajv";
import { DEFAULT_FEATURE_FLAGS, createFeatureFlagSnapshot } from "@mnemic/shared/flags";
import { RecallResultSchema } from "@mnemic/shared/memory";
import { retrieve } from "../src/retrieval/search.js";
import { respondToMessage } from "../src/chat/respond.js";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { readFeatureFlags } from "../src/flags/repository.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { durableModels } from "./fixtures/durable-models.js";
import { setupTestDb, type TestDb } from "./db-helper.js";

let t: TestDb, saved: Awaited<ReturnType<typeof readFeatureFlags>>;
const p = uuidv7(),
  other = uuidv7(),
  cp = uuidv7(),
  co = uuidv7(),
  mp = uuidv7(),
  mo = uuidv7();
const providerName = `entity-${uuidv7()}`,
  model = durableModels();
const flags = (extra = {}) => ({
  ...DEFAULT_FEATURE_FLAGS,
  retrieval_vector: false,
  retrieval_keyword: false,
  retrieval_entity: true,
  ...extra,
});
const snapshot = (extra = {}) =>
  createFeatureFlagSnapshot({ schema_version: 1, revision: 0, flags: flags(extra) });
const opts = (extra = {}) => ({
  providerName,
  factory: model.factory,
  flagsSnapshot: snapshot(),
  ...extra,
});
beforeAll(async () => {
  t = await setupTestDb();
  saved = await readFeatureFlags(t.db);
  await t.sql`insert into projects(id,name) values(${p},'entity runtime'),(${other},'other entity')`;
  for (const [project, conv, msg] of [
    [p, cp, mp],
    [other, co, mo],
  ]) {
    await t.sql`insert into conversations(id,project_id) values(${conv!},${project!})`;
    await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${msg!},${conv!},'user','offline',now())`;
  }
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: providerName,
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { embedding: "embed", chat: "chat", extraction: "extract" },
  });
}, 180000);
afterEach(async () => {
  model.embedding.mockClear();
  await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb,revision=${saved.revision} where scope='server'`;
  await t.sql`delete from retrieval_traces where project_id in (${p},${other})`;
  await t.sql`delete from model_usage where project_id in (${p},${other})`;
  await t.sql`update beliefs set current_version_id=null where project_id in (${p},${other})`;
  await t.sql`delete from memory_embeddings where belief_version_id in(select v.id from belief_versions v join beliefs b on b.id=v.belief_id where b.project_id in (${p},${other}))`;
  await t.sql`delete from belief_versions where belief_id in(select id from beliefs where project_id in (${p},${other}))`;
  await t.sql`delete from beliefs where project_id in (${p},${other})`;
  await t.sql`delete from observations where project_id in (${p},${other})`;
  await t.sql`delete from messages where conversation_id in (${cp},${co}) and id not in (${mp},${mo})`;
});
afterAll(async () => {
  if (t) {
    await t.sql`delete from provider_configs where name=${providerName}`;
    await t.sql`delete from messages where conversation_id in (${cp},${co})`;
    await t.sql`delete from conversations where project_id in (${p},${other})`;
    await t.sql`delete from projects where id in (${p},${other})`;
    await t.close();
  }
});
async function fact(
  entities: unknown = ["PostgreSQL"],
  extra: {
    project?: string;
    value?: string;
    indexed?: boolean;
    from?: string;
    to?: string;
    status?: string;
  } = {},
) {
  const b = uuidv7(),
    v = uuidv7(),
    o = uuidv7(),
    project = extra.project ?? p;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,evidence_id,assertion_intent,source_type,authority,entities) values(${o},${project},'fact',${b},'db',${JSON.stringify(extra.value ?? "answer")}::jsonb,${project === p ? mp : mo},'ASSERT','USER_EXPLICIT',60,${JSON.stringify(entities)}::jsonb)`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,status,confidence,salience,importance) values(${b},${project},${b},'db',${extra.status ?? "active"}::belief_status,0.8,0.4,0.2)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,valid_to,recorded_from,source_observation_id) values(${v},${b},${JSON.stringify(extra.value ?? "answer")}::jsonb,${extra.from ?? "2020-01-01"}::timestamptz,${extra.to ?? null}::timestamptz,'2020-01-01',${o})`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  if (extra.indexed)
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${v},${"[" + [1, ...Array(1023).fill(0)].join(",") + "]"}::vector,'embed')`;
  return { b, v, o };
}
async function trace(id: string) {
  return (await t.sql`select * from retrieval_traces where id=${id}`)[0]!;
}
it("entity-only normal retrieval finds a current-source label in a natural query without embedding or keyword hits", async () => {
  const a = await fact();
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "What database does PostgreSQL use?", opts());
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
  expect(r.candidates[0]).toMatchObject({ vectorScore: null, keywordScore: null, fusedScore: 1 });
  const row = await trace(r.traceId);
  expect(row.flags_snapshot).toEqual(snapshot());
  expect(row.candidates[0].entityMatch).toEqual({ policy: "query_labels_v1", score: 1 });
  expect(JSON.stringify(row.candidates)).not.toContain("PostgreSQL");
  expect(model.embedding).not.toHaveBeenCalled();
});
it("disabled entity leaves the legacy result and trace shape unchanged", async () => {
  await fact();
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "PostgreSQL",
    opts({ flagsSnapshot: snapshot({ retrieval_entity: false }) }),
  );
  expect(r.abstained).toBe(true);
  expect((await trace(r.traceId)).candidates).toEqual([]);
  expect(model.embedding).not.toHaveBeenCalled();
});
it("ordinary chat uses persisted entity flags and injects entity-only memory into the actual SDK prompt", async () => {
  const a = await fact(["PostgreSQL"], { value: "entity-only-memory-proof" });
  await t.sql`update feature_flags set flags=${JSON.stringify(flags())}::jsonb where scope='server'`;
  model.output([]);
  model.generate.mockClear();
  const jobs: (() => Promise<void>)[] = [];
  const r = await respondToMessage(t.db, TEST_MASTER_KEY, p, cp, "about PostgreSQL", {
    providerName,
    factory: model.factory,
    onJob: (job) => jobs.push(job),
  });
  expect(r.kind).toBe("answered");
  if (r.kind !== "answered") throw Error("chat failed");
  expect(r.abstained).toBe(false);
  expect(r.memories.map((m) => m.belief_version_id)).toEqual([a.v]);
  expect(JSON.stringify(model.generate.mock.calls)).toContain("entity-only-memory-proof");
  for (const job of jobs) await job();
  expect(model.embedding).not.toHaveBeenCalled();
});
it("entity augmentation never lowers the existing keyword score and leaves unmatched candidate metadata untouched", async () => {
  const a = await fact([], { value: "PostgreSQL" });
  const baseline = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "PostgreSQL",
    opts({ flagsSnapshot: snapshot({ retrieval_keyword: true, retrieval_entity: false }) }),
  );
  const enhanced = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "PostgreSQL",
    opts({ flagsSnapshot: snapshot({ retrieval_keyword: true }) }),
  );
  expect(enhanced.candidates).toEqual(baseline.candidates);
  expect(enhanced.candidates[0]!.beliefVersionId).toBe(a.v);
  expect((await trace(enhanced.traceId)).candidates).toEqual(
    (await trace(baseline.traceId)).candidates,
  );
});
it("normalizes NFKC/C-case and deduplicates query labels before scoring fractions", async () => {
  const a = await fact([" ＰＯＳＴＧＲＥＳＱＬ ", "postgresql", "postgresql", null, 42, {}]);
  const b = await fact(["Redis"]);
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "PostgreSQL + REDIS", opts());
  expect(new Set(r.candidates.map((c) => c.beliefVersionId))).toEqual(new Set([a.v, b.v]));
  expect(r.candidates.every((c) => c.fusedScore === 0.5)).toBe(true);
});
it.each([null, "PostgreSQL", {}, [null, 42, {}], ["", " ", "x".repeat(129), "bad\nlabel"]])(
  "malformed or invalid stored labels %# never create candidates",
  async (entities) => {
    await fact(entities);
    const r = await retrieve(
      t.db,
      TEST_MASTER_KEY,
      p,
      "PostgreSQL bad\nlabel " + "x".repeat(129),
      opts(),
    );
    expect(r.abstained).toBe(true);
    expect((await trace(r.traceId)).candidates).toEqual([]);
  },
);
it("matches punctuation and SQL-looking labels literally without LIKE or regex interpretation", async () => {
  const good = await fact(["%_';--"]);
  await fact(["a.b"]);
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "show %_';--", opts());
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
  expect((await retrieve(t.db, TEST_MASTER_KEY, p, "axb", opts())).abstained).toBe(true);
});
it("documents literal substring matching, including embedded Chinese labels and overlapping names", async () => {
  const chinese = await fact(["数据库"]),
    sub = await fact(["PostgreSQL"]);
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "我的数据库选PostgreSQLPlus", opts());
  expect(new Set(r.candidates.map((c) => c.beliefVersionId))).toEqual(new Set([chinese.v, sub.v]));
});
it("foreign, deleted, retracted, closed and corrupt current/source references cannot vote or affect the denominator", async () => {
  const good = await fact();
  const foreign = await fact(["Redis"], { project: other });
  await fact(["Redis"], { status: "deleted" });
  await fact(["Redis"], { status: "retracted" });
  const closed = await fact(["Redis"]),
    corrupt = await fact([]),
    source = await fact([]);
  await t.sql`update belief_versions set recorded_to=now() where id=${closed.v}`;
  await t.sql`update beliefs set current_version_id=${foreign.v} where id=${corrupt.b}`;
  await t.sql`update belief_versions set source_observation_id=${foreign.o} where id=${source.v}`;
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "PostgreSQL Redis", opts());
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
  expect(r.candidates[0]!.fusedScore).toBe(1);
});
it("old source labels never leak into an entity-free current version", async () => {
  const a = await fact(),
    v = uuidv7();
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${v},${a.b},'"new"','2021-01-01','2021-01-01')`;
  await t.sql`update beliefs set current_version_id=${v} where id=${a.b}`;
  expect((await retrieve(t.db, TEST_MASTER_KEY, p, "PostgreSQL", opts())).abstained).toBe(true);
});
it("time filters entity candidates and label discovery on the same current half-open interval", async () => {
  const a = await fact(["PostgreSQL"], {
    from: "2026-06-01T00:00:00.123456Z",
    to: "2026-06-01T00:00:00.123457Z",
  });
  await fact(["Redis"], { from: "2099-01-01" });
  const option = opts({
    flagsSnapshot: snapshot({ retrieval_time: true }),
    validAt: "2026-06-01T00:00:00.123456Z",
  });
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "PostgreSQL Redis", option);
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
  expect(r.candidates[0]!.fusedScore).toBe(1);
  expect(
    (
      await retrieve(t.db, TEST_MASTER_KEY, p, "PostgreSQL", {
        ...option,
        validAt: "2026-06-01T00:00:00.123457Z",
      })
    ).abstained,
  ).toBe(true);
});
it.each(["rrf", "weighted"] as const)(
  "explicit %s consumes query-derived entity votes and keeps metadata private",
  async (mode) => {
    const a = await fact();
    const fusion =
      mode === "rrf"
        ? { mode, threshold: 0.01 }
        : { mode, threshold: 0.3, weights: { vector: 0, keyword: 0, entity: 1, time: 0 } };
    const r = await retrieve(t.db, TEST_MASTER_KEY, p, "about PostgreSQL", opts({ fusion }));
    expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
    const c = (await trace(r.traceId)).candidates[0];
    expect(c.rankFusion.mode).toBe(mode);
    expect(c.rankFusion.components).toEqual([
      { route: "entity", rank: 1, score: 1, contribution: mode === "rrf" ? 1 / 61 : 1 },
    ]);
    expect(c.entityMatch).toEqual({ policy: "query_labels_v1", score: 1 });
    expect(r.candidates[0]).not.toHaveProperty("entityMatch");
  },
);
it("entity candidates pass through the existing budget and leave all memory rows unchanged", async () => {
  const a = await fact(),
    b = await fact();
  const rows = () =>
    t.sql`select row_to_json(b) as b,row_to_json(v) as v from beliefs b join belief_versions v on v.belief_id=b.id where b.project_id=${p} order by b.id,v.id`;
  const before = await rows();
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "PostgreSQL",
    opts({
      fusion: { mode: "rrf", threshold: 0.01 },
      memoryBudget: {
        maxTokens: 1,
        countTokens: (s: string) => (s === "（无相关记忆）" ? 0 : s.split("\n").length),
      },
    }),
  );
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
  expect(
    (await trace(r.traceId)).candidates.find(
      (c: { beliefVersionId: string }) => c.beliefVersionId === b.v,
    ).reason,
  ).toBe("token_budget");
  expect(await rows()).toEqual(before);
});
it("all16 source/time combinations work in both engines and only vector-on calls the embedding model", async () => {
  const a = await fact(["PostgreSQL"], { value: "PostgreSQL", indexed: true });
  await fact(["PostgreSQL"], { value: "PostgreSQL", indexed: true, to: "2021-01-01" });
  for (const fusion of [undefined, { mode: "rrf", threshold: 0.01 }])
    for (let mask = 0; mask < 16; mask++) {
      model.embedding.mockClear();
      const f = {
        retrieval_vector: !!(mask & 1),
        retrieval_keyword: !!(mask & 2),
        retrieval_entity: !!(mask & 4),
        retrieval_time: !!(mask & 8),
      };
      const r = await retrieve(
        t.db,
        TEST_MASTER_KEY,
        p,
        "PostgreSQL",
        opts({
          flagsSnapshot: snapshot(f),
          validAt: "2026-01-01T00:00:00Z",
          ...(fusion ? { fusion } : {}),
        }),
      );
      expect(r.abstained).toBe(!(mask & 7));
      if (mask & 7) expect(r.candidates.some((c) => c.beliefVersionId === a.v)).toBe(true);
      expect(r.candidates).toHaveLength(!(mask & 7) ? 0 : mask & 8 ? 1 : 2);
      expect(model.embedding).toHaveBeenCalledTimes(mask & 1 ? 1 : 0);
      expect((await trace(r.traceId)).flags_snapshot.flags).toEqual(flags(f));
    }
});
it("an embedding wait cannot change the operation's entity switch", async () => {
  const a = await fact(),
    input = { schema_version: 1 as const, revision: 0, flags: flags({ retrieval_vector: true }) };
  const normal = model.embedding.getMockImplementation()!;
  model.embedding.mockImplementationOnce(async (args) => {
    input.flags.retrieval_entity = false;
    return normal(args);
  });
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "PostgreSQL", opts({ flagsSnapshot: input }));
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
  expect((await trace(r.traceId)).flags_snapshot.flags.retrieval_entity).toBe(true);
});
it("query-label and candidate bounds are deterministic and unknown labels cannot force unbounded output", async () => {
  const terms = Array.from({ length: 33 }, (_, i) => "tag" + String(i).padStart(2, "0"));
  const good = await fact(terms.slice(0, 32));
  await fact([terms[32]]);
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, terms.join(" "), opts());
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([good.v]);
  for (let i = 0; i < 7; i++) await fact([terms[0]]);
  const bounded = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    terms[0]!,
    opts({
      topK: 200,
      fusion: { mode: "rrf", threshold: 0.01, perRouteLimit: 3, maxCandidates: 2 },
    }),
  );
  expect(bounded.candidates).toHaveLength(2);
  expect((await trace(bounded.traceId)).candidates).toHaveLength(2);
});
it("long normal chat queries stay on the legacy engine without fusion's shorter input limit", async () => {
  const a = await fact();
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "PostgreSQL " + "padding ".repeat(300),
    opts(),
  );
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
  expect((await trace(r.traceId)).candidates[0]).not.toHaveProperty("rankFusion");
});
it("authenticated TCP flags PUT enables ordinary recall while raw responses still match committed OpenAPI", async () => {
  const a = await fact();
  const app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: "offline-entity-token-000000000000",
    providerFactory: model.factory,
    logStream: { write: () => {} },
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const headers = {
    authorization: "Bearer offline-entity-token-000000000000",
    "content-type": "application/json",
  };
  try {
    const current = await readFeatureFlags(t.db);
    const put = await fetch(base + "/v1/config/flags", {
      method: "PUT",
      headers,
      body: JSON.stringify({ expected_revision: current.revision, flags: flags() }),
    });
    expect(put.status).toBe(200);
    const recall = await fetch(base + `/projects/${p}/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "about PostgreSQL" }),
    });
    expect(recall.status).toBe(200);
    const raw = await recall.json(),
      body = RecallResultSchema.parse(raw);
    const artifact = JSON.parse(
      readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv({ strict: false, formats: { uuid: true, "date-time": true } });
    ajv.addSchema({ components: artifact.components }, "entity-contract");
    const independent = ajv.compile(
      JSON.parse(
        JSON.stringify(
          artifact.paths["/projects/{projectId}/recall"].post.responses["200"].content[
            "application/json"
          ].schema,
        ).replaceAll('"#/components/', '"entity-contract#/components/'),
      ),
    );
    expect(independent(raw), JSON.stringify(independent.errors)).toBe(true);
    expect(body.candidates.map((c) => c.beliefVersionId)).toEqual([a.v]);
    expect(body.trace.flags_snapshot?.flags.retrieval_entity).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("query_labels_v1");
    expect((await trace(body.trace.id)).candidates[0].entityMatch.score).toBe(1);
    expect(model.embedding).not.toHaveBeenCalled();
    const rejected = await fetch(base + `/projects/${p}/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "PostgreSQL", entities: ["Redis"] }),
    });
    expect(rejected.status).toBe(400);
  } finally {
    await app.close();
  }
});
