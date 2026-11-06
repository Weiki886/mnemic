import { beforeAll, afterAll, afterEach, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { sql } from "drizzle-orm";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { readCandidateScores } from "../src/retrieval/candidates.js";
let t: TestDb;
const p = uuidv7(),
  other = uuidv7(),
  cp = uuidv7(),
  co = uuidv7(),
  mp = uuidv7(),
  mo = uuidv7();
const vector = (axis = 0) => Array.from({ length: 1024 }, (_, i) => (i === axis ? 1 : 0));
const allOff = {
  ...DEFAULT_FEATURE_FLAGS,
  retrieval_vector: false,
  retrieval_keyword: false,
  retrieval_entity: false,
  retrieval_time: false,
};
const input = (flags = { ...allOff, retrieval_entity: true }) => ({
  projectId: p,
  query: "PostgreSQL",
  entities: ["PostgreSQL"],
  validAt: "2026-06-01T00:00:00Z",
  embedding: { model: "offline", vector: vector() },
  fusion: { mode: "rrf", flags },
});
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${p},'candidate-scope'),(${other},'other-candidate-scope')`;
  for (const [project, c, m] of [
    [p, cp, mp],
    [other, co, mo],
  ]) {
    await t.sql`insert into conversations(id,project_id) values(${c!},${project!})`;
    await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${m!},${c!},'user','offline fact',now())`;
  }
}, 180000);
afterEach(async () => {
  await t.sql`update beliefs set current_version_id=null where project_id in (${p},${other})`;
  await t.sql`delete from memory_embeddings where belief_version_id in(select v.id from belief_versions v join beliefs b on b.id=v.belief_id where b.project_id in (${p},${other}))`;
  await t.sql`delete from belief_versions where belief_id in(select id from beliefs where project_id in (${p},${other}))`;
  await t.sql`delete from beliefs where project_id in (${p},${other})`;
  await t.sql`delete from observations where project_id in (${p},${other})`;
});
afterAll(async () => {
  if (t) {
    await t.sql`delete from messages where conversation_id in (${cp},${co})`;
    await t.sql`delete from conversations where project_id in (${p},${other})`;
    await t.sql`delete from projects where id in (${p},${other})`;
    await t.close();
  }
});
async function fact(
  options: {
    project?: string;
    entities?: unknown;
    value?: unknown;
    status?: string;
    from?: string;
    to?: string | null;
    recordedTo?: string | null;
    embedding?: { model: string; vector: number[] }[];
  } = {},
) {
  const project = options.project ?? p,
    b = uuidv7(),
    v = uuidv7(),
    o = uuidv7();
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,evidence_id,assertion_intent,source_type,authority,entities,valid_time) values(${o},${project},'fact',${b},'db',${JSON.stringify(options.value ?? "PostgreSQL")}::jsonb,${project === p ? mp : mo},'ASSERT','USER_EXPLICIT',60,${JSON.stringify(options.entities === undefined ? ["PostgreSQL"] : options.entities)}::jsonb,'1900-01-01')`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,status,confidence,salience,importance) values(${b},${project},${b},'db',${options.status ?? "active"}::belief_status,0.8,0.4,0.2)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,valid_to,recorded_from,recorded_to,source_observation_id) values(${v},${b},${JSON.stringify(options.value ?? "PostgreSQL")}::jsonb,${options.from ?? "2026-01-01T00:00:00Z"}::timestamptz,${options.to ?? null}::timestamptz,'2030-01-01',${options.recordedTo ?? null}::timestamptz,${o})`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  for (const e of options.embedding ?? [])
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values(${uuidv7()},${v},${"[" + e.vector.join(",") + "]"}::vector,${e.model})`;
  return { b, v, o };
}
it("entity recall is project/current/active scoped and rejects a current-version pointer into another belief", async () => {
  const good = await fact();
  await fact({ project: other });
  await fact({ status: "deleted" });
  await fact({ status: "retracted" });
  await fact({ status: "superseded" });
  await fact({ status: "expired" });
  await fact({ recordedTo: "2026-02-01T00:00:00Z" });
  const corrupt = await fact({ entities: [] });
  const foreign = await fact({ project: other });
  await t.sql`update beliefs set current_version_id=${foreign.v} where id=${corrupt.b}`;
  const result = await readCandidateScores(t.db, input());
  expect(result.map((r) => r.belief_version_id)).toEqual([good.v]);
});
it("current source Observation must independently belong to the same project", async () => {
  const own = await fact({ entities: [] }),
    foreign = await fact({ project: other });
  await t.sql`update belief_versions set source_observation_id=${foreign.o} where id=${own.v}`;
  expect(await readCandidateScores(t.db, input())).toEqual([]);
});
it("historical versions and their source entity labels never vote for the current version", async () => {
  const current = await fact({ entities: [] });
  const historical = uuidv7(),
    obs = uuidv7();
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,evidence_id,assertion_intent,source_type,authority,entities) values(${obs},${p},'fact','old','db','"old"',${mp},'ASSERT','USER_EXPLICIT',60,'["PostgreSQL"]')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,recorded_to,source_observation_id) values(${historical},${current.b},'"old"','2020-01-01','2020-01-01','2021-01-01',${obs})`;
  expect(await readCandidateScores(t.db, input())).toEqual([]);
});
it("entity labels are literal normalized matches; duplicates and malformed JSON never inflate the fraction", async () => {
  const good = await fact({
    entities: [" ＰＯＳＴＧＲＥＳＱＬ ", "postgresql", "postgresql", null, 42, {}],
  });
  await fact({ entities: "PostgreSQL" });
  await fact({ entities: null });
  await fact({ entities: { label: "PostgreSQL" } });
  await fact({ entities: ["PostgreSQLPlus"] });
  const result = await readCandidateScores(t.db, {
    ...input(),
    entities: ["PostgreSQL", " ＰＯＳＴＧＲＥＳＱＬ ", "Redis"],
  });
  expect(result.map((r) => r.belief_version_id)).toEqual([good.v]);
  expect(result[0]!.components[0]!.score).toBe(0.5);
  expect(await readCandidateScores(t.db, { ...input(), entities: ["%"] })).toEqual([]);
});
it("vector recall uses the selected model, best finite duplicate, and same-project current versions only", async () => {
  const good = await fact({
    embedding: [
      { model: "offline", vector: vector() },
      { model: "offline", vector: new Array(1024).fill(0) },
      { model: "offline", vector: vector(1) },
    ],
  });
  await fact({ embedding: [{ model: "other-model", vector: vector() }] });
  await fact({ project: other, embedding: [{ model: "offline", vector: vector() }] });
  const result = await readCandidateScores(t.db, input({ ...allOff, retrieval_vector: true }));
  expect(result.map((r) => r.belief_version_id)).toEqual([good.v]);
  expect(result[0]!.components).toHaveLength(1);
  expect(result[0]!.components[0]!.score).toBeCloseTo(1, 6);
  const extreme = await readCandidateScores(t.db, {
    ...input({ ...allOff, retrieval_vector: true }),
    embedding: { model: "offline", vector: vector().map((n) => n * 1e300) },
  });
  expect(extreme.map((r) => r.belief_version_id)).toEqual([good.v]);
  expect(extreme[0]!.components[0]!.score).toBeCloseTo(1, 6);
});
it("keyword recall retains literal AND semantics and normalizes only matching scores", async () => {
  const good = await fact({ value: "PostgreSQL storage storage" });
  await fact({ value: "PostgreSQL alone" });
  await fact({ project: other, value: "PostgreSQL storage storage storage" });
  const result = await readCandidateScores(t.db, {
    ...input({ ...allOff, retrieval_keyword: true }),
    query: "PostgreSQL storage",
  });
  expect(result.map((r) => r.belief_version_id)).toEqual([good.v]);
  expect(result[0]!.components[0]!.score).toBe(1);
  expect(
    await readCandidateScores(t.db, {
      ...input({ ...allOff, retrieval_keyword: true }),
      query: "% _",
    }),
  ).toEqual([]);
});
it("time filter is half-open current BeliefVersion validity, independent of Observation.valid_time or recorded_from", async () => {
  const inside = await fact({ from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
  const open = await fact({ from: "2020-01-01" });
  await fact({ from: "2026-06-02" });
  await fact({ to: "2026-06-01T00:00:00Z" });
  await fact({ from: "2026-06-01T00:00:00Z", to: "2026-06-01T00:00:00Z" });
  const result = await readCandidateScores(
    t.db,
    input({ ...allOff, retrieval_entity: true, retrieval_time: true }),
  );
  expect(result.map((r) => r.belief_version_id).sort()).toEqual([inside.v, open.v].sort());
  for (const row of result) expect(row.components.map((c) => c.route)).not.toContain("time");
});
it("time point keeps PostgreSQL microseconds rather than going through JS Date millisecond truncation", async () => {
  const good = await fact({
    from: "2026-06-01T00:00:00.123456Z",
    to: "2026-06-01T00:00:00.123457Z",
  });
  const data = {
    ...input({ ...allOff, retrieval_entity: true, retrieval_time: true }),
    validAt: "2026-06-01T00:00:00.123456Z",
  };
  expect((await readCandidateScores(t.db, data)).map((r) => r.belief_version_id)).toEqual([good.v]);
  expect(
    await readCandidateScores(t.db, { ...data, validAt: "2026-06-01T00:00:00.123457Z" }),
  ).toEqual([]);
});
it("the time gate filters vector and keyword too; disabling it leaves those source pools unfiltered", async () => {
  const expired = await fact({
    to: "2026-05-01",
    embedding: [{ model: "offline", vector: vector() }],
  });
  for (const source of ["retrieval_vector", "retrieval_keyword"] as const) {
    expect(
      await readCandidateScores(t.db, input({ ...allOff, [source]: true, retrieval_time: true })),
    ).toEqual([]);
    expect(
      (await readCandidateScores(t.db, input({ ...allOff, [source]: true }))).map(
        (r) => r.belief_version_id,
      ),
    ).toEqual([expired.v]);
  }
});
it("all16 source/time flag combinations compose correctly without a synthetic temporal vote", async () => {
  const valid = await fact({ embedding: [{ model: "offline", vector: vector() }] });
  const expired = await fact({
    to: "2026-05-01",
    embedding: [{ model: "offline", vector: vector() }],
  });
  for (let mask = 0; mask < 16; mask++) {
    const keys = [
      "retrieval_vector",
      "retrieval_keyword",
      "retrieval_entity",
      "retrieval_time",
    ] as const;
    const flags = {
      ...allOff,
      ...Object.fromEntries(keys.map((k, i) => [k, Boolean(mask & (1 << i))])),
    };
    const result = await readCandidateScores(t.db, input(flags));
    const sources = mask & 7;
    if (!sources) {
      expect(result).toEqual([]);
      continue;
    }
    expect(result.map((r) => r.belief_version_id).sort()).toEqual(
      (mask & 8 ? [valid.v] : [valid.v, expired.v]).sort(),
    );
    const count = [0, 1, 2].filter((i) => mask & (1 << i)).length;
    expect(result.every((r) => r.components.length === count)).toBe(true);
    expect(Number(result[0]!.fused_score)).toBeCloseTo(count / 61, 12);
  }
});
it("bounded source pools feed either fusion method and only return score metadata", async () => {
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await fact()).v);
  const data = {
    ...input(),
    fusion: {
      mode: "rrf",
      flags: { ...allOff, retrieval_entity: true },
      perRouteLimit: 3,
      maxCandidates: 2,
    },
  };
  const result = await readCandidateScores(t.db, data);
  expect(result.map((r) => r.belief_version_id)).toEqual(ids.sort().slice(0, 2));
  for (const r of result)
    expect(Object.keys(r).sort()).toEqual(["belief_version_id", "components", "fused_score"]);
  const weighted = await readCandidateScores(t.db, {
    ...data,
    fusion: {
      ...data.fusion,
      mode: "weighted",
      weights: { vector: 0, keyword: 0, entity: 1, time: 0 },
    },
  });
  expect(weighted.map((r) => r.belief_version_id)).toEqual(result.map((r) => r.belief_version_id));
  expect(weighted.map((r) => Number(r.fused_score))).toEqual([1, 1]);
});
it("input is captured before a database wait and selection does not mutate memory strength, versions or traces", async () => {
  const good = await fact();
  const before = await t.sql`select to_jsonb(b)::text as row from beliefs b where id=${good.b}`;
  const [countBefore] =
    await t.sql`select count(*)::int as n from retrieval_traces where project_id=${p}`;
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const db = new Proxy(t.db, {
    get(target, key) {
      if (key !== "execute") return Reflect.get(target, key, target);
      return async (q: Parameters<typeof target.execute>[0]) => {
        await wait;
        return target.execute(q);
      };
    },
  });
  const data = input();
  const promise = readCandidateScores(db, data);
  data.projectId = other;
  data.entities[0] = "Redis";
  data.fusion.flags.retrieval_entity = false;
  release();
  expect((await promise).map((r) => r.belief_version_id)).toEqual([good.v]);
  expect(await t.sql`select to_jsonb(b)::text as row from beliefs b where id=${good.b}`).toEqual(
    before,
  );
  expect(
    (await t.sql`select count(*)::int as n from retrieval_traces where project_id=${p}`)[0]!.n,
  ).toBe(countBefore!.n);
  await t.db.transaction(
    async (tx) => {
      expect(
        (
          await readCandidateScores(tx, {
            ...input(),
            fusion: {
              mode: "rrf",
              flags: { ...allOff, retrieval_entity: true, read_time_reinforcement: true },
            },
          })
        ).map((r) => r.belief_version_id),
      ).toEqual([good.v]);
    },
    { accessMode: "read only" },
  );
  const [versions] = await t.db.execute(
    sql`select count(*)::int as n from belief_versions where belief_id=${good.b}`,
  );
  expect(versions!.n).toBe(1);
});

it("selected model identifiers preserve exact factory spelling and remain bound SQL values", async () => {
  const model = " offline' quoted ";
  const good = await fact({ embedding: [{ model, vector: vector() }] });
  const data = {
    ...input({ ...allOff, retrieval_vector: true }),
    embedding: { model, vector: vector() },
  };
  expect((await readCandidateScores(t.db, data)).map((r) => r.belief_version_id)).toEqual([good.v]);
  expect(
    await readCandidateScores(t.db, {
      ...data,
      embedding: { ...data.embedding, model: model.trim() },
    }),
  ).toEqual([]);
});

it("independent bounded source pools can contribute disjoint IDs without adding a time-only pool", async () => {
  for (let i = 0; i < 3; i++) {
    await fact({
      value: "vector-only",
      entities: [],
      embedding: [{ model: "offline", vector: vector() }],
    });
    await fact({ value: "PostgreSQL", entities: [] });
    await fact({ value: "entity-only", entities: ["PostgreSQL"] });
  }
  const data = input({
    ...allOff,
    retrieval_vector: true,
    retrieval_keyword: true,
    retrieval_entity: true,
    retrieval_time: true,
  });
  const result = await readCandidateScores(t.db, {
    ...data,
    fusion: { ...data.fusion, perRouteLimit: 2, maxCandidates: 800 },
  });
  expect(result).toHaveLength(6);
  expect(new Set(result.map((r) => r.belief_version_id)).size).toBe(6);
  for (const route of ["vector", "keyword", "entity"])
    expect(
      result.filter((r) => r.components.length === 1 && r.components[0]!.route === route),
    ).toHaveLength(2);
});
