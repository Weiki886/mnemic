import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "@mnemic/shared";
import * as commands from "../src/memory-commands.js";
const project = "01920000-0000-7000-8000-000000000001";
const id = "01920000-0000-7000-8000-000000000002";
const score = {
  beliefVersionId: id,
  vectorScore: null,
  keywordScore: 1,
  fusedScore: 0.3,
  selected: true,
  reason: "top_k",
};
const result = {
  project_id: project,
  query: "PostgreSQL",
  abstained: false,
  candidates: [
    { ...score, beliefId: id, subject: "project", attribute: "db", value: "PostgreSQL" },
  ],
  trace: {
    id,
    reinforce_enabled: false,
    candidate_count: 1,
    truncated: false,
    candidates: [score],
  },
};
// 此边界有意注入不兼容的网络响应，验证运行时 schema，而非 TS fixture 声明。
const run = async (
  api: { recallBeliefs: (p: string, q: string) => Promise<unknown> },
  p = project,
  query = "PostgreSQL",
) => {
  expect(commands).toHaveProperty("runRecallCommand");
  return commands.runRecallCommand(api as commands.RecallApi, p, query);
};
describe("manual recall CLI runner", () => {
  it("shows content and exact component scores using one authenticated POST, no chat", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(result)));
    const api = createApiClient({
      baseUrl: "http://fixture.local",
      token: "fake-bearer",
      fetch,
      timeoutMs: 1000,
    });
    const text = await run(api);
    expect(text).toContain("PostgreSQL");
    expect(text).toContain(`trace ${id}`);
    expect(text).toContain("向量=未命中");
    expect(text).toContain("关键词=1.0000");
    expect(text).toContain("融合=0.3000");
    expect(text).toContain("top_k");
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      `http://fixture.local/projects/${project}/recall`,
    );
  });
  it("shows refusal, trace rejection reason and truncated count without fabricating content", async () => {
    const text = await run({
      recallBeliefs: async () => ({
        ...result,
        abstained: true,
        candidates: [],
        trace: {
          ...result.trace,
          candidate_count: 201,
          truncated: true,
          candidates: [{ ...score, selected: false, reason: "below_threshold" }],
        },
      }),
    });
    expect(text).toContain("拒答");
    expect(text).toContain("below_threshold");
    expect(text).toContain("1/201");
    expect(text).not.toContain(" = PostgreSQL");
  });
  it.each([
    { ...result, project_id: id },
    { ...result, query: "other" },
    { ...result, trace: { ...result.trace, reinforce_enabled: true } },
  ])("rejects incompatible scope or trace without retry %#", async (body) => {
    const recallBeliefs = vi.fn(async () => body);
    await expect(run({ recallBeliefs })).rejects.toThrow("未自动重试");
    expect(recallBeliefs).toHaveBeenCalledOnce();
  });
  it("sanitizes terminal controls and bounds current-value previews", async () => {
    const text = await run({
      recallBeliefs: async () => ({
        ...result,
        candidates: [
          { ...result.candidates[0], subject: "bad\u001b[2J", value: "x".repeat(10000) },
        ],
      }),
    });
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(1500);
  });
  it.each([401, 403, 404, 500])("never leaks error detail or retries after %s", async (status) => {
    const recallBeliefs = vi.fn(async () => {
      throw new ApiError(status, null, "private-key-secret");
    });
    const error = await run({ recallBeliefs }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-key-secret");
    expect(recallBeliefs).toHaveBeenCalledOnce();
  });
});
