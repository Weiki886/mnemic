import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { Ajv } from "ajv";
import { buildApp } from "../src/app.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { uuidv7 } from "uuidv7";
import { readFile } from "node:fs/promises";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { writeModelUsage, type UsageRecord } from "../src/usage/repository.js";
import { readUsageReport, readUsageExport } from "../src/usage/read.js";
import {
  UsageExportPageSchema,
  UsageExportQuerySchema,
  UsageQuerySchema,
} from "@mnemic/shared/usage";
import { usageCsv } from "../src/usage/csv.js";
import { parseUsagePricing } from "../src/usage/pricing.js";

let t: TestDb;
const project = uuidv7();
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${project},'rerank ledger')`;
}, 180000);
afterAll(async () => {
  await t?.close();
});
const record = (): UsageRecord => ({
  projectId: project,
  conversationId: null,
  providerName: "qwen-score-api",
  modelId: "Qwen/Qwen3-Reranker-0.6B",
  slot: "reranker",
  purpose: "rerank",
  status: "success",
  startedAt: new Date("2026-11-01T00:00:00Z"),
  durationMs: 3,
  promptTokens: 12,
  completionTokens: 0,
  totalTokens: 17,
  reasoningTokens: null,
  cachedInputTokens: null,
});
it("persists reranker in its own ledger category and reports/exports exact independent counts", async () => {
  await writeModelUsage(t.db, record());
  const query = { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" };
  const report = await readUsageReport(
    t.db,
    project,
    UsageQuerySchema.parse({ ...query, group_by: "model" }),
  );
  expect(report.totals.calls).toBe(1);
  expect(report.totals.total_tokens).toEqual({ reported: "17", missing_calls: 0 });
  expect(report.groups[0]?.key).toEqual({
    provider_name: "qwen-score-api",
    model_id: record().modelId,
    slot: "reranker",
  });
  const page = await readUsageExport(t.db, project, UsageExportQuerySchema.parse(query));
  expect(page.records[0]).toMatchObject({
    slot: "reranker",
    purpose: "rerank",
    prompt_tokens: "12",
    completion_tokens: "0",
    total_tokens: "17",
    estimated_cost: null,
  });
  expect(usageCsv(page)).toContain('"reranker","rerank"');
});
it("a reranker rate uses reported input/output only and unknown output remains unpriced", async () => {
  const scope = uuidv7();
  await t.sql`insert into projects(id,name) values(${scope},'rates')`;
  await writeModelUsage(t.db, { ...record(), projectId: scope, completionTokens: null });
  const prices = parseUsagePricing(
    JSON.stringify({
      currency: "USD",
      rates: [
        {
          provider_name: "qwen-score-api",
          model_id: record().modelId,
          slot: "reranker",
          effective_from: "2026-10-01T00:00:00Z",
          input_per_million: "1",
          output_per_million: "2",
        },
      ],
    }),
  );
  const query = UsageQuerySchema.parse({
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-02T00:00:00Z",
  });
  const r = await readUsageReport(t.db, scope, query, prices);
  expect(r.totals.estimated_cost).toEqual({
    known_amount: null,
    priced_calls: 0,
    unpriced_calls: 1,
  });
  await writeModelUsage(t.db, { ...record(), projectId: scope });
  const after = await readUsageReport(t.db, scope, query, prices);
  expect(after.totals.estimated_cost).toEqual({
    known_amount: "0.000012000000",
    priced_calls: 1,
    unpriced_calls: 1,
  });
});

it("upgrades the old three-category CHECK idempotently and preserves all legacy records", async () => {
  const sql = await readFile(
    new URL("../drizzle/0018_reranker_usage_category.sql", import.meta.url),
    "utf8",
  );
  const connection = postgres(t.url, { max: 1 });
  try {
    await connection`create temporary table model_usage (slot text constraint model_usage_slot_check check (slot in ('chat','extraction','embedding')))`;
    await connection`insert into model_usage(slot) values('chat'),('extraction'),('embedding')`;
    for (let n = 0; n < 2; n++) await connection.unsafe(sql);
    await connection`insert into model_usage(slot) values('reranker')`;
    const rows = await connection`select slot from model_usage order by slot`;
    expect(rows.map((r) => r.slot)).toEqual(["chat", "embedding", "extraction", "reranker"]);
    await expect(connection`insert into model_usage(slot) values('unknown')`).rejects.toMatchObject(
      { code: "23514" },
    );
  } finally {
    await connection.end();
  }
});
it("real authenticated HTTP exports the new category against the committed OpenAPI artifact", async () => {
  const scope = uuidv7();
  await t.sql`insert into projects(id,name) values(${scope},'rerank export')`;
  await writeModelUsage(t.db, { ...record(), projectId: scope });
  const app = buildApp({
    db: t.db,
    authToken: "offline-reranker-ledger-token-0000000000",
    logStream: { write: () => {} },
  });
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(
      `${base}/projects/${scope}/usage/export?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`,
      { headers: { authorization: "Bearer offline-reranker-ledger-token-0000000000" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const value = await res.json();
    const doc = JSON.parse(
      await readFile(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
    ) as OpenApiDocument;
    const ajv = new Ajv({ strict: false, formats: { uuid: true, "date-time": true } });
    ajv.addSchema({ components: doc.components }, "usage");
    const schema =
      doc.paths["/projects/{projectId}/usage/export"]!.get!.responses!["200"]!.content[
        "application/json"
      ]!.schema;
    const validate = ajv.compile(
      JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"usage#/components/')),
    );
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    const page = UsageExportPageSchema.parse(value);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      slot: "reranker",
      purpose: "rerank",
      total_tokens: "17",
    });
  } finally {
    await app.close();
  }
});
