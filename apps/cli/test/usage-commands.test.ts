import { expect, it, vi } from "vitest";
import { runUsageCommand } from "../src/usage-commands.js";
import { parseChatInput, completeSlash, slashHelp } from "../src/slash-commands.js";
import type { UsageReport } from "@mnemic/shared/usage";
const project = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a",
  conversation = "0192af91-0000-7000-8000-000000000200";
const metric = { reported: "90071992547409930", missing_calls: 1 };
function report(): UsageReport {
  return {
    project_id: project,
    conversation_id: null,
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-02T00:00:00Z",
    currency: "USD",
    pricing_revision: "a".repeat(64),
    group_by: "day",
    groups_truncated: false,
    groups: [],
    totals: {
      calls: 3,
      success_calls: 1,
      error_calls: 1,
      aborted_calls: 1,
      duration_ms: "20",
      prompt_tokens: metric,
      completion_tokens: metric,
      total_tokens: metric,
      reasoning_tokens: metric,
      cached_input_tokens: metric,
      estimated_cost: { known_amount: "0.000123456789", priced_calls: 2, unpriced_calls: 1 },
    },
  };
}
it("registers an independent read-only usage command with defaults and current scope", () => {
  expect(parseChatInput("/usage")).toMatchObject({
    kind: "command",
    name: "usage",
    current: false,
    query: { group_by: "day" },
  });
  expect(
    parseChatInput("/usage --current --group-by model --from 2026-10-01T00:00:00Z"),
  ).toMatchObject({
    name: "usage",
    current: true,
    query: { group_by: "model", from: "2026-10-01T00:00:00Z" },
  });
  expect(completeSlash("/usa").value).toBe("/usage ");
  expect(slashHelp()).toContain("/usage");
});
it.each([
  "/usage hi",
  "/usage --current --current",
  "/usage --group-by day --group-by model",
  "/usage --from invalid",
  "/usage --secret value",
  "/usage --group-by invalid",
  "/usage --group-by=",
])("rejects invalid usage syntax locally: %s", (text) => {
  expect(parseChatInput(text).kind).toBe("error");
});
it("preserves exact token and money strings, missing coverage and actual UTC window", async () => {
  const getUsageReport = vi.fn(async () => report());
  const text = await runUsageCommand({ getUsageReport }, project, null, {
    current: false,
    query: {},
  });
  expect(text).toContain("90071992547409930");
  expect(text).toContain("未报告 1 次");
  expect(text).toContain("USD 0.000123456789");
  expect(text).toContain("未估价 1 次");
  expect(text).toContain("非账单");
  expect(text).toContain("2026-10-01T00:00:00Z");
  expect(getUsageReport).toHaveBeenCalledOnce();
});
it("current scope uses physical session id and no session fails before HTTP", async () => {
  const getUsageReport = vi.fn(async () => ({ ...report(), conversation_id: conversation }));
  await runUsageCommand({ getUsageReport }, project, conversation, { current: true, query: {} });
  expect(getUsageReport).toHaveBeenCalledWith(
    project,
    expect.objectContaining({ conversation_id: conversation }),
  );
  getUsageReport.mockClear();
  await expect(
    runUsageCommand({ getUsageReport }, project, null, { current: true, query: {} }),
  ).rejects.toThrow("会话");
  expect(getUsageReport).not.toHaveBeenCalled();
});
it("unknown price is not rendered as free and bounded groups say when details are omitted", async () => {
  const r = report();
  r.currency = null;
  r.pricing_revision = null;
  r.totals.estimated_cost = { known_amount: null, priced_calls: 0, unpriced_calls: 3 };
  r.groups = Array.from({ length: 25 }, (_, i) => ({
    key: { model_id: `safe-${i}\u001b[31m` },
    totals: r.totals,
  }));
  const text = await runUsageCommand({ getUsageReport: async () => r }, project, null, {
    current: false,
    query: {},
  });
  expect(text).toContain("费用未知");
  expect(text).not.toContain("USD 0");
  expect(text).not.toContain("\u001b");
  expect(text).toContain("仅显示 20/25");
  expect(text).not.toContain("safe-24");
});
it("rejects foreign, incompatible and failed responses without printing upstream payloads or retrying", async () => {
  for (const response of [
    { ...report(), project_id: conversation },
    { ...report(), conversation_id: conversation },
    { ...report(), group_by: "model" },
    {},
  ]) {
    await expect(
      runUsageCommand({ getUsageReport: async () => response as UsageReport }, project, null, {
        current: false,
        query: {},
      }),
    ).rejects.toThrow("用量读取失败");
  }
  const getUsageReport = vi.fn(async () => {
    throw new Error("PRIVATE-KEY");
  });
  await expect(
    runUsageCommand({ getUsageReport }, project, null, { current: false, query: {} }),
  ).rejects.toThrow("用量读取失败");
  expect(getUsageReport).toHaveBeenCalledOnce();
});
