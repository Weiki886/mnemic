import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { parseUsagePricing } from "../src/usage/pricing.js";
import { UsageReportSchema, UsageExportPageSchema } from "@mnemic/shared/usage";
const p = uuidv7(),
  other = uuidv7(),
  c1 = uuidv7(),
  c2 = uuidv7(),
  foreign = uuidv7();
const ids = Array.from({ length: 5 }, () => uuidv7()),
  token = "usage-read-token-".repeat(3);
const headers = { authorization: `Bearer ${token}` },
  provider = "=SUM(1,2)",
  model = 'chat "v1"\nnext';
const pricing = parseUsagePricing(
  JSON.stringify({
    currency: "USD",
    rates: [
      {
        provider_name: provider,
        model_id: model,
        slot: "chat",
        effective_from: "2026-10-01T00:00:00Z",
        input_per_million: "2",
        output_per_million: "4",
        cached_input_per_million: "0.5",
      },
      {
        provider_name: "offline",
        model_id: "embed",
        slot: "embedding",
        effective_from: "2026-10-01T00:00:00Z",
        input_per_million: "1",
        output_per_million: "0",
      },
    ],
  }),
);
const bounds = "from=2026-10-01T00%3A00%3A00Z&to=2026-10-04T00%3A00%3A00Z";
let t: TestDb, app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${p},'usage-read'),(${other},'other')`;
  await t.sql`insert into conversations(id,project_id) values(${c1},${p}),(${c2},${p}),(${foreign},${other})`;
  for (const [
    i,
    project,
    conversation,
    date,
    slot,
    status,
    prompt,
    completion,
    total,
    cached,
    duration,
  ] of [
    [0, p, c1, "2026-10-02", "chat", "success", 100, 10, 150, 20, 12],
    [1, p, c1, "2026-10-02", "chat", "error", null, 3, 3, null, 5],
    [2, p, c2, "2026-10-03", "embedding", "success", 30, null, 30, null, 3],
    [3, p, c1, "2026-10-04", "chat", "aborted", null, null, null, null, 1],
    [4, other, foreign, "2026-10-02", "chat", "success", 999, 999, 1998, 0, 1],
  ] as const) {
    await t.sql`insert into model_usage(id,project_id,conversation_id,provider_name,model_id,slot,purpose,status,started_at,duration_ms,prompt_tokens,completion_tokens,total_tokens,cached_input_tokens)
    values(${ids[i]!},${project},${conversation},${slot === "chat" ? provider : "offline"},${slot === "chat" ? model : "embed"},${slot},${slot === "chat" ? "chat" : "embedding_query"},${status},${date + (i < 2 ? "T00:00:00.123456Z" : "T00:00:00Z")},${duration},${prompt},${completion},${total},${cached})`;
  }
  app = buildApp({ db: t.db, authToken: token, usagePricing: pricing });
}, 180000);
afterAll(async () => {
  await app?.close();
  await t?.close();
});
const get = (tail = "", project = p) =>
  app.inject({ url: `/projects/${project}/usage?${bounds}${tail}`, headers });
const exportPage = (tail = "") =>
  app.inject({ url: `/projects/${p}/usage/export?${bounds}${tail}`, headers });
it("aggregates one SQL selection with exact token sums, missing coverage, half-open time and cached estimates", async () => {
  const res = await get();
  expect(res.statusCode).toBe(200);
  const r = UsageReportSchema.parse(res.json());
  expect(r.totals).toMatchObject({
    calls: 3,
    success_calls: 2,
    error_calls: 1,
    aborted_calls: 0,
    duration_ms: "20",
    prompt_tokens: { reported: "130", missing_calls: 1 },
    total_tokens: { reported: "183", missing_calls: 0 },
    completion_tokens: { reported: "13", missing_calls: 1 },
    reasoning_tokens: { reported: "0", missing_calls: 3 },
    estimated_cost: { known_amount: "0.000240000000", priced_calls: 2, unpriced_calls: 1 },
  });
  expect(r.groups.map((g) => g.key)).toEqual([{ day: "2026-10-02" }, { day: "2026-10-03" }]);
  expect(r.currency).toBe("USD");
  expect(r.pricing_revision).toBe(pricing.revision);
  expect(res.headers["cache-control"]).toBe("no-store");
});
it("filters physical conversations and keeps totals complete when groups are truncated", async () => {
  const filtered = (await get(`&conversation_id=${c1}&group_by=model`)).json();
  expect(filtered.totals.calls).toBe(2);
  expect(filtered.groups[0].key).toMatchObject({
    provider_name: provider,
    model_id: model,
    slot: "chat",
  });
  const truncated = (await get("&group_limit=1")).json();
  expect(truncated.totals.calls).toBe(3);
  expect(truncated.groups).toHaveLength(1);
  expect(truncated.groups_truncated).toBe(true);
  expect((await get("&group_by=conversation")).json().groups).toHaveLength(2);
  expect(
    (await get("&group_by=purpose")).json().groups.map((g: { key: unknown }) => g.key),
  ).toContainEqual({ purpose: "embedding_query" });
});
it("does not reveal foreign conversations or cursors", async () => {
  expect((await get(`&conversation_id=${foreign}`)).statusCode).toBe(404);
  expect((await get("", uuidv7())).statusCode).toBe(404);
  expect((await exportPage(`&after=${ids[4]}`)).statusCode).toBe(404);
  expect((await exportPage(`&conversation_id=${c2}&after=${ids[0]}`)).statusCode).toBe(404);
  expect((await get("", other)).json().totals.calls).toBe(1);
});
it("exports complete keyset pages with timestamp ties, exact nulls, literal strings and explicit next cursor", async () => {
  const a = await exportPage("&limit=2"),
    first = UsageExportPageSchema.parse(a.json());
  expect(first.records.map((r) => r.id)).toEqual(ids.slice(0, 2));
  expect(first.next_after).toBe(ids[1]);
  expect(first.records[0]).toMatchObject({
    provider_name: provider,
    model_id: model,
    estimated_cost: "0.000210000000",
  });
  expect(first.records[1]!.prompt_tokens).toBeNull();
  const last = UsageExportPageSchema.parse(
    (await exportPage(`&after=${first.next_after}&limit=2`)).json(),
  );
  expect(last.records.map((r) => r.id)).toEqual([ids[2]]);
  expect(last.next_after).toBeNull();
});
it("CSV quotes comma/newline/quotes, neutralizes formulas, and advertises pagination without inventing zero for null", async () => {
  const res = await exportPage("&format=csv&limit=1");
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/csv");
  expect(res.headers["content-disposition"]).toContain("attachment");
  expect(res.headers["x-next-after"]).toBe(ids[0]);
  expect(res.body).toContain('"\'=SUM(1,2)"');
  expect(res.body).toContain('"chat ""v1""\nnext"');
  expect(res.body).toContain('"0.000210000000"');
  expect(res.body).toContain('"project_id","currency","pricing_revision"');
  expect(res.body).toContain(`"${p}","USD","${pricing.revision}"`);
  const missing = await exportPage(`&format=csv&limit=1&after=${ids[0]}`);
  expect(missing.body).toContain('"5","","3","3","","",""');
  expect(res.headers["cache-control"]).toBe("no-store");
});
it("rejects invalid windows, dates, params and pagination with structured 400 details", async () => {
  for (const url of [
    `/projects/bad/usage`,
    `/projects/${p}/usage?from=2026-02-30T00:00:00Z`,
    `/projects/${p}/usage?from=2020-01-01T00:00:00Z`,
    `/projects/${p}/usage?from=2026-10-03T00:00:00Z&to=2026-10-02T00:00:00Z`,
    `/projects/${p}/usage?sql=1`,
    `/projects/${p}/usage/export?limit=1001`,
  ]) {
    const res = await app.inject({ url, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.length).toBeGreaterThan(0);
  }
});
it("auth runs before validation or any database lookup", async () => {
  const select = vi.spyOn(t.db, "select"),
    execute = vi.spyOn(t.db, "execute");
  try {
    for (const path of ["usage", "usage/export"])
      expect((await app.inject({ url: `/projects/bad/${path}?bad=1` })).statusCode).toBe(401);
    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally {
    select.mockRestore();
    execute.mockRestore();
  }
});

it("missing prices and empty selections remain explicit rather than claiming a free bill", async () => {
  const unpriced = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
  try {
    const res = await unpriced.inject({ url: `/projects/${p}/usage?${bounds}`, headers });
    expect(res.json()).toMatchObject({
      currency: null,
      pricing_revision: null,
      totals: {
        calls: 3,
        estimated_cost: { known_amount: null, priced_calls: 0, unpriced_calls: 3 },
      },
    });
    const empty = await unpriced.inject({
      url: `/projects/${p}/usage?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z`,
      headers,
    });
    expect(empty.json()).toMatchObject({
      groups: [],
      totals: {
        calls: 0,
        prompt_tokens: { reported: "0", missing_calls: 0 },
        estimated_cost: { known_amount: null, unpriced_calls: 0 },
      },
    });
  } finally {
    await unpriced.close();
  }
});
it("latest effective price wins without rewriting historical counters", async () => {
  const latest = parseUsagePricing(
    JSON.stringify({
      currency: "USD",
      rates: [
        ...pricing.rates,
        {
          ...pricing.rates[0],
          effective_from: "2026-10-02T00:00:00Z",
          input_per_million: "3",
          output_per_million: "6",
          cached_input_per_million: "1",
        },
      ],
    }),
  );
  const otherApp = buildApp({
    db: t.db,
    authToken: token,
    usagePricing: latest,
    logStream: { write: () => {} },
  });
  try {
    const res = await otherApp.inject({
      url: `/projects/${p}/usage/export?${bounds}&limit=1`,
      headers,
    });
    expect(res.json().records[0]).toMatchObject({
      prompt_tokens: "100",
      estimated_cost: "0.000320000000",
    });
    expect(res.json().pricing_revision).not.toBe(pricing.revision);
  } finally {
    await otherApp.close();
  }
});
it("SQL aggregate retains integers beyond JavaScript safe range without converting through Number", async () => {
  const huge = uuidv7();
  await t.sql`insert into projects(id,name) values(${huge},'huge')`;
  for (let i = 0; i < 2; i++)
    await t.sql`insert into model_usage(id,project_id,provider_name,model_id,slot,purpose,status,started_at,duration_ms,prompt_tokens) values(${uuidv7()},${huge},'offline','large','chat','chat','success','2026-10-02',9007199254740991,9007199254740991)`;
  const r = (await get("", huge)).json();
  expect(r.totals.prompt_tokens.reported).toBe("18014398509481982");
  expect(r.totals.duration_ms).toBe("18014398509481982");
});
it("cached pricing refuses missing or inconsistent cache counts even with known prompt and completion", async () => {
  const cache = uuidv7();
  await t.sql`insert into projects(id,name) values(${cache},'cache')`;
  for (const n of [null, 101])
    await t.sql`insert into model_usage(id,project_id,provider_name,model_id,slot,purpose,status,started_at,duration_ms,prompt_tokens,completion_tokens,cached_input_tokens) values(${uuidv7()},${cache},${provider},${model},'chat','chat','success','2026-10-02',1,100,10,${n})`;
  expect((await get("", cache)).json().totals.estimated_cost).toEqual({
    known_amount: null,
    priced_calls: 0,
    unpriced_calls: 2,
  });
});
