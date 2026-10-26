import { mount, flushPromises } from "@vue/test-utils";
import { expect, it, vi } from "vitest";
import UsageView from "../src/views/UsageView.vue";
import type { UsageReport } from "@mnemic/shared/usage";
const project = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a",
  other = "0192af91-0000-7000-8000-000000000200";
function report(p = project): UsageReport {
  const metric = { reported: "90071992547409930", missing_calls: 2 };
  return {
    project_id: p,
    conversation_id: null,
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-02T00:00:00Z",
    group_by: "day",
    currency: "USD",
    pricing_revision: "a".repeat(64),
    groups_truncated: true,
    totals: {
      calls: 3,
      success_calls: 1,
      error_calls: 1,
      aborted_calls: 1,
      duration_ms: "100",
      prompt_tokens: metric,
      completion_tokens: metric,
      total_tokens: metric,
      reasoning_tokens: metric,
      cached_input_tokens: metric,
      estimated_cost: { known_amount: "0.000123456789", priced_calls: 1, unpriced_calls: 2 },
    },
    groups: [],
  };
}
it("shows exact reported tokens, missing coverage, partial cost and the actual UTC window", async () => {
  const getUsageReport = vi.fn(async () => report()),
    view = mount(UsageView, { props: { projectId: project, api: { getUsageReport } } });
  await flushPromises();
  expect(view.text()).toContain("90071992547409930");
  expect(view.text()).toContain("未报告 2 次");
  expect(view.text()).toContain("USD 0.000123456789");
  expect(view.text()).toContain("未估价 2 次");
  expect(view.text()).toContain("非账单");
  expect(view.text()).toContain("2026-10-01T00:00:00Z");
  expect(view.text()).toContain("分组已截断");
  expect(getUsageReport).toHaveBeenCalledOnce();
  view.unmount();
});
it("unknown prices and empty data never show a free total", async () => {
  const r = report();
  r.currency = null;
  r.pricing_revision = null;
  r.totals.calls = 0;
  r.totals.estimated_cost = { known_amount: null, priced_calls: 0, unpriced_calls: 0 };
  const view = mount(UsageView, {
    props: { projectId: project, api: { getUsageReport: async () => r } },
  });
  await flushPromises();
  expect(view.text()).toContain("费用未知");
  expect(view.text()).toContain("无模型调用记录");
  expect(view.text()).not.toContain("USD 0");
  view.unmount();
});
it("applies explicit time, conversation and grouping filters", async () => {
  const getUsageReport = vi.fn(async (_p, q) => ({
    ...report(),
    conversation_id: q.conversation_id ?? null,
    group_by: q.group_by,
    from: q.from ?? report().from,
    to: q.to ?? report().to,
  }));
  const view = mount(UsageView, { props: { projectId: project, api: { getUsageReport } } });
  await flushPromises();
  await view.get('[aria-label="会话 UUID"]').setValue(other);
  await view.get('[aria-label="开始时间 ISO"]').setValue(report().from);
  await view.get('[aria-label="结束时间 ISO"]').setValue(report().to);
  await view.get('[aria-label="分组方式"]').setValue("model");
  await view.get("form").trigger("submit");
  await flushPromises();
  expect(getUsageReport).toHaveBeenLastCalledWith(
    project,
    expect.objectContaining({
      conversation_id: other,
      from: report().from,
      to: report().to,
      group_by: "model",
    }),
  );
  view.unmount();
});
it("invalid input fails locally and removes stale totals", async () => {
  const getUsageReport = vi.fn(async () => report()),
    view = mount(UsageView, { props: { projectId: project, api: { getUsageReport } } });
  await flushPromises();
  await view.get('[aria-label="会话 UUID"]').setValue("invalid");
  await view.get("form").trigger("submit");
  await flushPromises();
  expect(getUsageReport).toHaveBeenCalledOnce();
  expect(view.text()).toContain("查询参数无效");
  expect(view.text()).not.toContain("90071992547409930");
  view.unmount();
});
it("project switching ignores a late old report", async () => {
  let resolve!: (r: UsageReport) => void;
  const old = new Promise<UsageReport>((r) => {
    resolve = r;
  });
  const getUsageReport = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce({ ...report(other), totals: { ...report().totals, calls: 22 } });
  const view = mount(UsageView, { props: { projectId: project, api: { getUsageReport } } });
  await view.setProps({ projectId: other });
  await flushPromises();
  resolve({ ...report(), totals: { ...report().totals, calls: 999 } });
  await flushPromises();
  expect(view.text()).toContain("调用 22");
  expect(view.text()).not.toContain("999");
  view.unmount();
});
it.each(["failure", "foreign"])(
  "fails closed without leaking response details: %s",
  async (kind) => {
    const getUsageReport = async () => {
      if (kind === "failure") throw new Error("PRIVATE-TOKEN");
      return report(other);
    };
    const view = mount(UsageView, { props: { projectId: project, api: { getUsageReport } } });
    await flushPromises();
    expect(view.text()).toContain("用量加载失败");
    expect(view.text()).not.toContain("PRIVATE-TOKEN");
    expect(view.text()).not.toContain("90071992547409930");
    view.unmount();
  },
);
