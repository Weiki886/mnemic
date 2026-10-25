import { expect, it } from "vitest";
import { UsageQuerySchema, UsageExportQuerySchema, UsageReportSchema } from "../src/usage.js";
it("validates explicit ISO dates, UUID scope and bounded pagination without accepting extra keys", () => {
  expect(UsageQuerySchema.parse({ group_by: "model" }).group_limit).toBe(200);
  expect(UsageExportQuerySchema.parse({ limit: "1000" }).limit).toBe(1000);
  for (const query of [
    { group_by: "sql" },
    { from: "2026-02-30T00:00:00Z" },
    { conversation_id: "x" },
    { from: "yesterday" },
    { provider_key: "x" },
    { group_limit: "1001" },
  ])
    expect(UsageQuerySchema.safeParse(query).success).toBe(false);
  for (const query of [
    { limit: 0 },
    { limit: 1001 },
    { after: "x" },
    { format: "xml" },
    { group_by: "day" },
  ])
    expect(UsageExportQuerySchema.safeParse(query).success).toBe(false);
});
it("keeps very large aggregate counters as exact decimal strings and exposes missing coverage", () => {
  const metric = { reported: "90071992547409930", missing_calls: 2 };
  const totals = {
    calls: 3,
    success_calls: 1,
    error_calls: 1,
    aborted_calls: 1,
    duration_ms: "99999999999999999",
    prompt_tokens: metric,
    completion_tokens: metric,
    total_tokens: metric,
    reasoning_tokens: metric,
    cached_input_tokens: metric,
    estimated_cost: { known_amount: null, priced_calls: 0, unpriced_calls: 3 },
  };
  const r = UsageReportSchema.parse({
    project_id: "019a19da-7454-7b46-b716-e39383f37a53",
    conversation_id: null,
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-02T00:00:00Z",
    currency: null,
    pricing_revision: null,
    group_by: "day",
    groups_truncated: false,
    totals,
    groups: [],
  });
  expect(r.totals.prompt_tokens).toEqual(metric);
});
