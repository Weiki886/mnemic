import { describe, expect, it, vi } from "vitest";
import * as memory from "../src/memory.js";
import { createApiClient } from "../src/api.js";

const id = "01920000-0000-7000-8000-000000000001";
const score = {
  beliefVersionId: id,
  vectorScore: null,
  keywordScore: 1,
  fusedScore: 0.3,
  selected: true,
  reason: "top_k",
};
const response = {
  project_id: id,
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

describe("manual recall contracts (#32)", () => {
  it("validates bounded request and score-only trace", () => {
    expect(memory).toHaveProperty("RecallRequestSchema");
    expect(memory).toHaveProperty("RecallResultSchema");
    const { RecallRequestSchema, RecallResultSchema } = memory;
    expect(RecallRequestSchema.parse({ query: " PostgreSQL " })).toEqual({ query: "PostgreSQL" });
    for (const query of ["", " ", "x".repeat(1001)])
      expect(RecallRequestSchema.safeParse({ query }).success).toBe(false);
    expect(RecallRequestSchema.safeParse({ query: "db", reinforce: true }).success).toBe(false);
    expect(RecallResultSchema.parse(response)).toEqual(response);
    for (const bad of [
      { ...response, abstained: true },
      { ...response, trace: { ...response.trace, reinforce_enabled: true } },
      { ...response, trace: { ...response.trace, candidates: [{ ...score, value: "snapshot" }] } },
      { ...response, trace: { ...response.trace, candidate_count: 0 } },
      { ...response, trace: { ...response.trace, candidates: [{ ...score, selected: false }] } },
    ])
      expect(RecallResultSchema.safeParse(bad).success).toBe(false);
    expect(
      RecallResultSchema.safeParse({
        ...response,
        abstained: true,
        candidates: [],
        trace: { ...response.trace, candidates: [], candidate_count: 0 },
      }).success,
    ).toBe(true);
  });

  it("posts query with bearer and timeout through shared transport", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
    const api = createApiClient({
      baseUrl: "http://fixture.local",
      token: "offline-token",
      timeoutMs: 5000,
      fetch,
    });
    expect(api).toHaveProperty("recallBeliefs");
    await api.recallBeliefs(id, "PostgreSQL");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://fixture.local/projects/${id}/recall`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ query: "PostgreSQL" }));
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer offline-token");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
