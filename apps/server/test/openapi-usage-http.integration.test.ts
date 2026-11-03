import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildApp } from "../src/app.js";
import { parseUsagePricing } from "../src/usage/pricing.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import type { UsageReport, UsageExportPage } from "@mnemic/shared/usage";
import { setupTestDb, type TestDb } from "./db-helper.js";
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "date-time": /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/,
  },
});
ajv.addSchema({ components: doc.components }, "usage");
const reportPath = "/projects/{projectId}/usage",
  exportPath = reportPath + "/export";
const p = uuidv7(),
  other = uuidv7(),
  c1 = uuidv7(),
  c2 = uuidv7(),
  foreign = uuidv7();
const ids = Array.from({ length: 7 }, () => uuidv7());
const provider = "=SUM(1,2)",
  model = 'chat "v1"\nnext';
const token = "usage-contract-offline-0000000000",
  headers = { authorization: `Bearer ${token}` };
const models = vi.fn(() => {
  throw Error("usage reads must not resolve or invoke models");
});
const from = "2026-10-01T00:00:00Z",
  to = "2026-10-04T00:00:00Z";
const prices = parseUsagePricing(
  JSON.stringify({
    currency: "USD",
    rates: [
      {
        provider_name: provider,
        model_id: model,
        slot: "chat",
        effective_from: from,
        input_per_million: "2",
        output_per_million: "4",
        cached_input_per_million: "0.5",
      },
      {
        provider_name: "offline",
        model_id: "embed",
        slot: "embedding",
        effective_from: from,
        input_per_million: "1",
        output_per_million: "0",
      },
    ],
  }),
);
let t: TestDb, app: ReturnType<typeof buildApp>, base: string;
function validate(schema: unknown, value: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"usage#/components/')),
  );
  expect(v(value), JSON.stringify(v.errors)).toBe(true);
}
function bounds(extra: Record<string, string> = {}) {
  return new URLSearchParams({ from, to, ...extra }).toString();
}
function examples(path: string) {
  const op = doc.paths[path]!.get!;
  const q = new URLSearchParams();
  for (const param of op.parameters as {
    in: string;
    name: string;
    example?: unknown;
    schema: unknown;
  }[]) {
    if (param.example === undefined) continue;
    validate(param.schema, param.example);
    if (param.in === "query") q.set(param.name, String(param.example));
  }
  expect(q.get("from")).toBe(from);
  expect(q.get("to")).toBe(to);
  return q.toString();
}
async function request<T = unknown>(
  path: string,
  status: number,
  query = bounds(),
  opts: { project?: string; auth?: boolean; accept?: string } = {},
  origin = base,
) {
  const r = await fetch(origin + path.replace("{projectId}", opts.project ?? p) + "?" + query, {
    headers: { ...(opts.auth === false ? {} : headers), accept: opts.accept ?? "*/*" },
  });
  const csv = r.headers.get("content-type")?.startsWith("text/csv");
  const body: unknown = csv ? await r.text() : await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("x-request-id")).toBeTruthy();
  const op = doc.paths[path]!.get!;
  const res = op.responses[String(status)] as
    | {
        content: Record<string, { schema: unknown }>;
        headers?: Record<string, { schema: unknown }>;
      }
    | undefined;
  expect(res, `undocumented ${path} ${status}`).toBeTruthy();
  const media = status >= 400 ? "application/problem+json" : csv ? "text/csv" : "application/json";
  expect(r.headers.get("content-type")).toContain(media);
  validate(res!.content[media]!.schema, body);
  if (status === 200) {
    expect(r.headers.get("cache-control")).toBe("no-store");
    if (path === exportPath) {
      expect(r.headers.get("x-usage-from")).toBeTruthy();
      expect(r.headers.get("x-usage-to")).toBeTruthy();
    }
  }
  for (const name of [
    "Cache-Control",
    "X-Usage-From",
    "X-Usage-To",
    "X-Next-After",
    "Content-Disposition",
  ]) {
    const value = r.headers.get(name);
    if (value !== null && res!.headers?.[name]) validate(res!.headers[name]!.schema, value);
  }
  return { body: body as T, response: r };
}
async function audits() {
  return t.sql`select actor,action,target,decision,meta from audit_log where target=${p} and action='usage.export' order by ts,id`;
}
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${p},'usage-contract'),(${other},'foreign-usage-contract')`;
  await t.sql`insert into conversations(id,project_id) values(${c1},${p}),(${c2},${p}),(${foreign},${other})`;
  for (const [
    i,
    project,
    conversation,
    time,
    slot,
    status,
    prompt,
    completion,
    total,
    cached,
    duration,
    prov,
    mod,
  ] of [
    [
      0,
      p,
      c1,
      "2026-10-02T00:00:00.123456Z",
      "chat",
      "success",
      "100",
      "10",
      "150",
      "20",
      "12",
      provider,
      model,
    ],
    [
      1,
      p,
      c1,
      "2026-10-02T00:00:00.123457Z",
      "chat",
      "error",
      null,
      "3",
      "3",
      null,
      "5",
      provider,
      model,
    ],
    [
      2,
      p,
      c2,
      "2026-10-02T00:00:00.123457Z",
      "chat",
      "success",
      "9007199254740993",
      "0",
      "9007199254741000",
      "0",
      "9007199254740994",
      "offline",
      "unpriced",
    ],
    [
      3,
      p,
      c2,
      "2026-10-03T00:00:00Z",
      "embedding",
      "aborted",
      "30",
      null,
      "30",
      null,
      "3",
      "offline",
      "embed",
    ],
    [4, p, c1, to, "chat", "aborted", null, null, null, null, "1", provider, model],
    [
      5,
      other,
      foreign,
      "2026-10-02T00:00:00Z",
      "chat",
      "success",
      "999",
      "999",
      "1998",
      "0",
      "1",
      "foreign-provider",
      "foreign-model",
    ],
    [
      6,
      null,
      null,
      "2026-10-02T00:00:00Z",
      "chat",
      "success",
      "777",
      "0",
      "777",
      "0",
      "1",
      "probe-provider",
      "probe-model",
    ],
  ] as const) {
    await t.sql`insert into model_usage (id,project_id,conversation_id,provider_name,model_id,slot,purpose,status,started_at,duration_ms,prompt_tokens,completion_tokens,total_tokens,cached_input_tokens) values (${ids[i]!},${project},${conversation},${prov},${mod},${slot},${i === 6 ? "probe" : slot === "embedding" ? "embedding_query" : "chat"},${status},${time},${duration},${prompt},${completion},${total},${cached})`;
  }
  app = buildApp({
    db: t.db,
    authToken: token,
    usagePricing: prices,
    providerFactory: { languageModel: models, embeddingModel: models },
    logStream: { write: () => {} },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  try {
    await app?.close();
    if (t) {
      await t.sql`delete from audit_log where target=${p} and action='usage.export'`;
      await t.sql`delete from model_usage where id in ${t.sql(ids)}`;
      await t.sql`delete from conversations where project_id in (${p},${other})`;
      await t.sql`delete from projects where id in (${p},${other})`;
    }
  } finally {
    await t?.close();
  }
  expect(models).not.toHaveBeenCalled();
});
it("published report query executes with exact large counters, missing coverage, half-open window and estimates", async () => {
  const before = await audits();
  const { body: r, response } = await request<UsageReport>(reportPath, 200, examples(reportPath), {
    project: p.toUpperCase(),
  });
  expect(r).toMatchObject({
    project_id: p,
    conversation_id: null,
    group_by: "day",
    currency: "USD",
    pricing_revision: prices.revision,
    groups_truncated: false,
    totals: {
      calls: 4,
      success_calls: 2,
      error_calls: 1,
      aborted_calls: 1,
      duration_ms: "9007199254741014",
      prompt_tokens: { reported: "9007199254741123", missing_calls: 1 },
      completion_tokens: { reported: "13", missing_calls: 1 },
      total_tokens: { reported: "9007199254741183", missing_calls: 0 },
      reasoning_tokens: { reported: "0", missing_calls: 4 },
      estimated_cost: { known_amount: "0.000240000000", priced_calls: 2, unpriced_calls: 2 },
    },
  });
  expect(r.groups.map((g) => g.key)).toEqual([{ day: "2026-10-02" }, { day: "2026-10-03" }]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await audits()).toEqual(before);
  expect(JSON.stringify(r)).not.toMatch(/foreign-provider|probe-provider/);
});
it.each(["day", "model", "purpose", "conversation"])(
  "group_by=%s retains complete totals when group detail is capped",
  async (group_by) => {
    const { body: r } = await request<UsageReport>(
      reportPath,
      200,
      bounds({ group_by, group_limit: "1" }),
    );
    expect(r.totals.calls).toBe(4);
    expect(r.groups).toHaveLength(1);
    expect(r.groups_truncated).toBe(true);
    expect(r.group_by).toBe(group_by);
  },
);
it("conversation filters refer to physical ownership rather than inherited history", async () => {
  const { body: r } = await request<UsageReport>(reportPath, 200, bounds({ conversation_id: c1 }));
  expect(r).toMatchObject({
    conversation_id: c1,
    totals: { calls: 2, total_tokens: { reported: "153", missing_calls: 0 } },
  });
});
it("default time window is server now minus30 days and missing prices remain unknown", async () => {
  const unpriced = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
  const origin = await unpriced.listen({ host: "127.0.0.1", port: 0 });
  try {
    const before = Date.now();
    const { body: r } = await request<UsageReport>(reportPath, 200, "", {}, origin);
    expect(Date.parse(r.to)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(r.to)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(r.to) - Date.parse(r.from)).toBe(30 * 86400000);
    const result = await request<UsageReport>(reportPath, 200, bounds(), {}, origin);
    expect(result.body).toMatchObject({
      currency: null,
      pricing_revision: null,
      totals: {
        calls: 4,
        estimated_cost: { known_amount: null, priced_calls: 0, unpriced_calls: 4 },
      },
    });
  } finally {
    await unpriced.close();
  }
});
it("empty selections preserve unknown amount rather than claiming zero-cost usage", async () => {
  const { body: r } = await request<UsageReport>(
    reportPath,
    200,
    bounds({ from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" }),
  );
  expect(r.groups).toEqual([]);
  expect(r.totals).toMatchObject({
    calls: 0,
    prompt_tokens: { reported: "0", missing_calls: 0 },
    estimated_cost: { known_amount: null, priced_calls: 0, unpriced_calls: 0 },
  });
});
it("published JSON export example selects JSON despite Accept CSV and commits a minimal prepared receipt", async () => {
  const before = (await audits()).length;
  const { body: r, response } = await request<UsageExportPage>(
    exportPath,
    200,
    examples(exportPath),
    { accept: "text/csv" },
  );
  expect(r.records.map((v) => v.id)).toEqual(ids.slice(0, 2));
  expect(r.next_after).toBe(ids[1]);
  expect(r.records[0]).toMatchObject({
    started_at: "2026-10-02T00:00:00.123456Z",
    estimated_cost: "0.000210000000",
    provider_name: provider,
    model_id: model,
  });
  expect(r.records[1]!.prompt_tokens).toBeNull();
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(response.headers.get("x-next-after")).toBe(ids[1]);
  expect(response.headers.get("x-usage-from")).toBe(r.from);
  expect(response.headers.get("x-usage-to")).toBe(r.to);
  const rows = await audits();
  expect(rows).toHaveLength(before + 1);
  const receipt = rows.at(-1)!;
  expect(receipt).toEqual({
    actor: "server",
    action: "usage.export",
    target: p,
    decision: "prepared",
    meta: {
      version: 1,
      project_id: p,
      conversation_id: null,
      format: "json",
      rows: 2,
      from: r.from,
      to: r.to,
      after: null,
      next_after: ids[1],
    },
  });
  expect(JSON.stringify(receipt)).not.toContain(provider);
  expect(JSON.stringify(receipt)).not.toContain(model);
});
it("keyset pagination preserves microseconds and ties with exact counters and no duplicated IDs", async () => {
  const seen: string[] = [];
  let after: string | undefined;
  const before = (await audits()).length;
  let resolvedFrom = from,
    resolvedTo = to;
  for (let page = 0; page < 4; page++) {
    const { body: r, response } = await request<UsageExportPage>(
      exportPath,
      200,
      bounds({ from: resolvedFrom, to: resolvedTo, limit: "1", ...(after ? { after } : {}) }),
    );
    resolvedFrom = r.from;
    resolvedTo = r.to;
    expect(r.records).toHaveLength(1);
    seen.push(r.records[0]!.id);
    if (page === 2)
      expect(r.records[0]).toMatchObject({
        prompt_tokens: "9007199254740993",
        duration_ms: "9007199254740994",
        estimated_cost: null,
      });
    if (page < 3) {
      expect(r.next_after).toBe(r.records[0]!.id);
      expect(response.headers.get("x-next-after")).toBe(r.next_after);
      after = r.next_after!;
    } else {
      expect(r.next_after).toBeNull();
      expect(response.headers.get("x-next-after")).toBeNull();
    }
  }
  expect(seen).toEqual(ids.slice(0, 4));
  expect(new Set(seen).size).toBe(4);
  expect(await audits()).toHaveLength(before + 4);
});
it("CSV is independently checked as text with formula escaping, quotes, CRLF, null cells and page headers", async () => {
  const { body: csv, response } = await request<string>(
    exportPath,
    200,
    bounds({ format: "csv", limit: "2" }),
    { accept: "application/json" },
  );
  const header =
    '"project_id","currency","pricing_revision","id","conversation_id","provider_name","model_id","slot","purpose","status","started_at","duration_ms","prompt_tokens","completion_tokens","total_tokens","reasoning_tokens","cached_input_tokens","estimated_cost"\r\n';
  const first = `"${p}","USD","${prices.revision}","${ids[0]}","${c1}","'=SUM(1,2)","chat ""v1""\nnext","chat","chat","success","2026-10-02T00:00:00.123456Z","12","100","10","150","","20","0.000210000000"\r\n`;
  const second = `"${p}","USD","${prices.revision}","${ids[1]}","${c1}","'=SUM(1,2)","chat ""v1""\nnext","chat","chat","error","2026-10-02T00:00:00.123457Z","5","","3","3","","",""\r\n`;
  expect(csv).toBe(header + first + second);
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="usage.csv"');
  expect(response.headers.get("x-next-after")).toBe(ids[1]);
  expect(response.headers.get("access-control-expose-headers")).toBe(
    "X-Next-After, X-Usage-From, X-Usage-To",
  );
  const last = await request<string>(exportPath, 200, bounds({ format: "csv", after: ids[3]! }));
  expect(last.body).toBe(header);
  expect(last.response.headers.get("x-next-after")).toBeNull();
});
it.each([reportPath, exportPath])(
  "%s rejects missing/foreign conversation/project before exposing records or writing audit",
  async (path) => {
    const before = await audits();
    await request(path, 404, bounds({ conversation_id: foreign }));
    await request(path, 404, bounds(), { project: uuidv7() });
    expect(await audits()).toEqual(before);
  },
);
it.each([ids[5]!, ids[4]!, uuidv7()])(
  "foreign/out-of-window/missing cursor %s returns scoped404 without receipt",
  async (after) => {
    const before = await audits();
    await request(exportPath, 404, bounds({ after }));
    expect(await audits()).toEqual(before);
  },
);
it("cursor from another physical conversation is rejected inside same project", async () => {
  await request(exportPath, 404, bounds({ conversation_id: c2, after: ids[0]! }));
});
it.each([
  { path: reportPath, q: "extra=unknown" },
  { path: reportPath, q: bounds({ group_by: "invalid" }) },
  { path: reportPath, q: bounds({ group_limit: "1001" }) },
  { path: reportPath, q: bounds({ conversation_id: "bad" }) },
  { path: reportPath, q: bounds({ from: "2026-02-30T00:00:00Z" }) },
  { path: reportPath, q: bounds({ from: "2026-10-04T00:00:00Z" }) },
  { path: reportPath, q: bounds({ from: "2020-01-01T00:00:00Z" }) },
  { path: reportPath, q: bounds({ from: "2026-10-01T00:00:00.1234Z" }) },
  { path: reportPath, q: bounds() + "&group_by=day&group_by=model" },
  { path: exportPath, q: bounds({ limit: "0" }) },
  { path: exportPath, q: bounds({ format: "yaml" }) },
  { path: exportPath, q: bounds({ after: "bad" }) },
  { path: exportPath, q: bounds({ extra: "unknown" }) },
])("strict/time/pagination validation returns structured400: $q", async ({ path, q }) => {
  const { body } = await request<{ errors: unknown[] }>(path, 400, q);
  expect(body.errors.length).toBeGreaterThan(0);
});
it.each([reportPath, exportPath])("%s invalid project UUID returns structured400", async (path) => {
  const { body } = await request<{ errors: unknown[] }>(path, 400, bounds(), { project: "bad" });
  expect(body.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "projectId" })]),
  );
});
it("authentication precedes schema validation and any database operation", async () => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get: () => {
      reads++;
      throw Error("DB touched");
    },
  });
  const denied = buildApp({ db, authToken: token, logStream: { write: () => {} } });
  const origin = await denied.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const path of [reportPath, exportPath])
      await request(path, 401, "bad=1", { project: "bad", auth: false }, origin);
    expect(reads).toBe(0);
  } finally {
    await denied.close();
  }
});
it("audit failure prevents sending CSV/JSON and commits no prepared receipt", async () => {
  const constraint = "contract_usage_" + uuidv7().replaceAll("-", "");
  const before = await audits();
  await t.sql.unsafe(
    `alter table audit_log add constraint ${constraint} check (action <> 'usage.export' or target <> '${p}') not valid`,
  );
  try {
    for (const format of ["json", "csv"]) {
      const { body, response } = await request<{ detail: string }>(
        exportPath,
        500,
        bounds({ format }),
      );
      expect(body.detail).toBe("服务器内部错误");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("x-next-after")).toBeNull();
      expect(JSON.stringify(body)).not.toContain(constraint);
    }
    expect(await audits()).toEqual(before);
  } finally {
    await t.sql.unsafe(`alter table audit_log drop constraint ${constraint}`);
  }
});
it("database errors stay fixed500 and HTTP429 rejects before another database access", async () => {
  let reads = 0;
  const secret = "sk-usage-private-sql-123456789012345678901234",
    logs: string[] = [];
  const db = new Proxy({} as PostgresJsDatabase, {
    get: () => {
      reads++;
      throw Error(secret);
    },
  });
  const failed = buildApp({
    db,
    authToken: token,
    rateLimit: { ip: { capacity: 2, refillPerSecond: 0.001 } },
    logStream: {
      write: (s) => {
        logs.push(s);
      },
    },
  });
  const origin = await failed.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const path of [reportPath, exportPath]) {
      const r = await request<{ detail: string }>(path, 500, bounds(), {}, origin);
      expect(r.body.detail).toBe("服务器内部错误");
    }
    const before = reads;
    const r = await request(exportPath, 429, bounds(), {}, origin);
    expect(r.response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(reads).toBe(before);
    expect(logs.join("")).not.toContain(secret);
  } finally {
    await failed.close();
  }
});
it("without database configuration both operations remain absent404", async () => {
  const bare = buildApp({ authToken: token, logStream: { write: () => {} } });
  const origin = await bare.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const path of [reportPath, exportPath]) await request(path, 404, bounds(), {}, origin);
  } finally {
    await bare.close();
  }
});

it("offset timestamps normalize to UTC bounds without changing day groups or selection", async () => {
  const a = await request<UsageReport>(reportPath, 200, bounds());
  const b = await request<UsageReport>(
    reportPath,
    200,
    bounds({ from: "2026-10-01T08:00:00+08:00", to: "2026-10-04T08:00:00+08:00" }),
  );
  expect(b.body).toEqual(a.body);
});
