import { afterAll, beforeAll, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { buildRankFusionQuery } from "../src/retrieval/fusion.js";
const a = "01900000-0000-7000-8000-000000000001",
  b = "01900000-0000-7000-8000-000000000002",
  c = "01900000-0000-7000-8000-000000000003";
const flags = { ...DEFAULT_FEATURE_FLAGS, retrieval_entity: true, retrieval_time: true };
const weights = { vector: 0.7, keyword: 0.3, entity: 0, time: 0 };
type Score = [string | null, string | null, number | string | null];
type Row = {
  belief_version_id: string;
  fused_score: string;
  components: { route: string; rank: number; score: number; contribution: number }[];
};
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
}, 180000);
afterAll(async () => {
  await t?.close();
});
async function run(scores: Score[], options: unknown = { mode: "rrf", flags }) {
  const query = buildRankFusionQuery(options);
  return execute(scores, query);
}
async function execute(scores: Score[], query: SQL) {
  const source = scores.length
    ? sql`values ${sql.join(
        scores.map(([id, route, score]) => sql`(${id}::uuid,${route}::text,${score}::float8)`),
        sql`,`,
      )}`
    : sql`select null::uuid,null::text,null::float8 where false`;
  return t.db.execute<Row>(
    sql`with recall_scores(belief_version_id,route,score) as (${source}) ${query}`,
  );
}
it("RRF sums reciprocal one-based route ranks rather than weighted score magnitudes; same pool supports comparison", async () => {
  const scores: Score[] = [
    [a, "vector", 1],
    [b, "vector", 0.8],
    [b, "keyword", 1],
    [c, "keyword", 0.9],
  ];
  const rrf = await run(scores);
  expect(rrf.map((r) => r.belief_version_id)).toEqual([b, a, c]);
  expect(Number(rrf[0]!.fused_score)).toBeCloseTo(1 / 62 + 1 / 61, 14);
  expect(rrf[0]!.components).toEqual([
    { route: "keyword", rank: 1, score: 1, contribution: expect.closeTo(1 / 61, 14) },
    { route: "vector", rank: 2, score: 0.8, contribution: expect.closeTo(1 / 62, 14) },
  ]);
  const weighted = await run(scores, { mode: "weighted", flags, weights });
  expect(weighted.map((r) => r.belief_version_id)).toEqual([b, a, c]);
  expect(Number(weighted[0]!.fused_score)).toBeCloseTo(0.7 * 0.8 + 0.3, 14);
  expect(Number(weighted[1]!.fused_score)).toBeCloseTo(0.7, 14);
});
it("rank ordering is independent of raw score scale and can differ from the weighted baseline", async () => {
  const scores: Score[] = [
    [a, "vector", 0.99],
    [b, "vector", 0.01],
    [b, "keyword", 0.01],
  ];
  expect((await run(scores)).map((r) => r.belief_version_id)).toEqual([b, a]);
  expect(
    (await run(scores, { mode: "weighted", flags, weights })).map((r) => r.belief_version_id),
  ).toEqual([a, b]);
  const scaled = await run(scores.map(([id, route, score]) => [id, route, Number(score) * 10000]));
  expect(scaled.map((r) => [r.belief_version_id, r.fused_score])).toEqual(
    (await run(scores)).map((r) => [r.belief_version_id, r.fused_score]),
  );
});
it("ties use UUID order inside each route and at the final fused boundary, independent of source order", async () => {
  const scores: Score[] = [
    [c, "vector", 1],
    [b, "vector", 1],
    [a, "keyword", 1],
  ];
  const first = await run(scores),
    second = await run([...scores].reverse());
  expect(first).toEqual(second);
  expect(first.map((r) => r.belief_version_id)).toEqual([a, b, c]);
  expect(first.find((r) => r.belief_version_id === b)!.components[0]!.rank).toBe(1);
  expect(first.find((r) => r.belief_version_id === c)!.components[0]!.rank).toBe(2);
});
it("duplicate version/route rows use the best finite score exactly once before ranking and clipping", async () => {
  const result = await run(
    [
      [a, "vector", 0.1],
      [a, "vector", 0.8],
      [a, "vector", "NaN"],
      [a, "vector", "Infinity"],
      [b, "vector", 0.6],
    ],
    { mode: "rrf", flags, perRouteLimit: 1 },
  );
  expect(result).toHaveLength(1);
  expect(result[0]!.belief_version_id).toBe(a);
  expect(result[0]!.components).toEqual([
    { route: "vector", rank: 1, score: 0.8, contribution: expect.closeTo(1 / 61, 14) },
  ]);
});
it("null IDs/routes/scores, unknown routes and nonfinite values cannot create a fusion candidate", async () => {
  const result = await run([
    [null, "vector", 1],
    [a, null, 1],
    [a, "unexpected", 1],
    [a, "vector", null],
    [a, "vector", "NaN"],
    [a, "keyword", "Infinity"],
    [a, "time", "-Infinity"],
    [b, "entity", 0.5],
  ]);
  expect(result.map((r) => r.belief_version_id)).toEqual([b]);
});
it("empty input and all routes disabled return empty rows", async () => {
  expect(await run([])).toEqual([]);
  expect(
    await run(
      [
        [a, "vector", 1],
        [b, "keyword", 1],
        [c, "entity", 1],
      ],
      {
        mode: "rrf",
        flags: {
          ...flags,
          retrieval_vector: false,
          retrieval_keyword: false,
          retrieval_entity: false,
          retrieval_time: false,
        },
      },
    ),
  ).toEqual([]);
});
it.each(["vector", "keyword", "entity", "time"] as const)(
  "only the independently enabled %s route contributes",
  async (route) => {
    const enabled = {
      ...flags,
      retrieval_vector: false,
      retrieval_keyword: false,
      retrieval_entity: false,
      retrieval_time: false,
      [`retrieval_${route}`]: true,
    };
    const result = await run(
      [
        [a, "vector", 0.5],
        [a, "keyword", 0.5],
        [a, "entity", 0.5],
        [a, "time", 0.5],
      ],
      { mode: "rrf", flags: enabled },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.components.map((c) => c.route)).toEqual([route]);
    expect(Number(result[0]!.fused_score)).toBeCloseTo(1 / 61, 14);
  },
);
it("per-route pool and final output caps are distinct; clipped route ranks are not re-added", async () => {
  const result = await run(
    [
      [a, "vector", 0.9],
      [b, "vector", 0.8],
      [b, "keyword", 1],
      [c, "keyword", 0.9],
    ],
    { mode: "rrf", flags, perRouteLimit: 1, maxCandidates: 1 },
  );
  expect(result.map((r) => r.belief_version_id)).toEqual([a]);
  expect(result[0]!.components.map((c) => c.route)).toEqual(["vector"]);
});
it("k is a bound parameter and changes the reciprocal denominator, not rank positions", async () => {
  const result = await run(
    [
      [a, "time", 0],
      [b, "time", -0.1],
    ],
    { mode: "rrf", flags, k: 1 },
  );
  expect(result.map((r) => Number(r.fused_score))).toEqual([0.5, 1 / 3]);
});
it("disabled routes do not renormalize weighted coefficients and negative finite scores stay distinguishable from absence", async () => {
  const result = await run(
    [
      [a, "keyword", 1],
      [b, "keyword", -0.5],
      [a, "vector", 1],
    ],
    { mode: "weighted", flags: { ...flags, retrieval_vector: false }, weights },
  );
  expect(result.map((r) => Number(r.fused_score))).toEqual([0.3, -0.15]);
  expect(result.every((r) => r.components.length === 1)).toBe(true);
});
it("four-route RRF emits score-only evidence and extreme finite scores remain numeric text", async () => {
  const result = await run(["vector", "keyword", "entity", "time"].map((route) => [a, route, 1]));
  expect(Number(result[0]!.fused_score)).toBeCloseTo(4 / 61, 14);
  expect(Object.keys(result[0]!).sort()).toEqual([
    "belief_version_id",
    "components",
    "fused_score",
  ]);
  for (const component of result[0]!.components)
    expect(Object.keys(component).sort()).toEqual(["contribution", "rank", "route", "score"]);
  const large = await run(
    [
      [a, "vector", 1e308],
      [a, "keyword", 1e308],
    ],
    { mode: "weighted", flags, weights },
  );
  expect(typeof large[0]!.fused_score).toBe("string");
  expect(Number(large[0]!.fused_score)).toBe(1e308);
});
it("changing caller flags, weights or limits after building cannot change captured SQL parameters", async () => {
  const options = {
    mode: "weighted",
    flags: { ...flags },
    weights: { ...weights },
    maxCandidates: 1,
  };
  const query = buildRankFusionQuery(options);
  options.flags.retrieval_vector = false;
  options.weights.vector = 0;
  options.weights.keyword = 1;
  options.maxCandidates = 800;
  const result = await execute(
    [
      [a, "vector", 1],
      [b, "keyword", 1],
    ],
    query,
  );
  expect(result.map((r) => r.belief_version_id)).toEqual([a]);
  expect(Number(result[0]!.fused_score)).toBe(0.7);
});

it("all 16 route masks affect RRF and weighted contributions independently without renormalization", async () => {
  const routes = ["vector", "keyword", "entity", "time"] as const;
  const equal = { vector: 0.25, keyword: 0.25, entity: 0.25, time: 0.25 };
  for (let mask = 0; mask < 16; mask++) {
    const enabled = {
      ...flags,
      ...Object.fromEntries(
        routes.map((route, i) => [`retrieval_${route}`, Boolean(mask & (1 << i))]),
      ),
    };
    const source: Score[] = routes.map((route) => [a, route, 1]);
    const expected = routes.filter((_, i) => mask & (1 << i));
    for (const mode of ["rrf", "weighted"]) {
      const result = await run(source, {
        mode,
        flags: enabled,
        ...(mode === "weighted" ? { weights: equal } : {}),
      });
      if (expected.length === 0) {
        expect(result).toEqual([]);
        continue;
      }
      expect(result).toHaveLength(1);
      expect(result[0]!.components.map((c) => c.route).sort()).toEqual([...expected].sort());
      expect(Number(result[0]!.fused_score)).toBeCloseTo(
        mode === "rrf" ? expected.length / 61 : expected.length / 4,
        14,
      );
    }
  }
});
it("the largest accepted per-route and union limits return exactly 800 unique candidates rather than silently truncating", async () => {
  const id = (n: number) => "01900000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const source: Score[] = ["vector", "keyword", "entity", "time"].flatMap((route, lane) =>
    Array.from({ length: 201 }, (_, i): Score => [id(lane * 201 + i + 1), route, 1]),
  );
  const result = await run(source, { mode: "rrf", flags, perRouteLimit: 200, maxCandidates: 800 });
  expect(result).toHaveLength(800);
  expect(new Set(result.map((r) => r.belief_version_id)).size).toBe(800);
  for (const n of [201, 402, 603, 804])
    expect(result.some((r) => r.belief_version_id === id(n))).toBe(false);
});
it("fusion SELECT is usable inside a read-only transaction without persistence", async () => {
  await t.db.transaction(
    async (tx) => {
      const result = await tx.execute(
        sql`with recall_scores(belief_version_id,route,score) as (values(${a}::uuid,'vector'::text,1::float8)) ${buildRankFusionQuery({ mode: "rrf", flags })}`,
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.belief_version_id).toBe(a);
    },
    { accessMode: "read only" },
  );
});
