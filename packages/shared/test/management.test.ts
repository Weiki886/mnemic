import { describe, expect, it, vi } from "vitest";
import * as management from "../src/management.js";
import { createApiClient } from "../src/api.js";
const id = "01920000-0000-7000-8000-000000000001";
describe("management contracts (#32)", () => {
  it("permits only nonempty whitelisted provider changes, never inline credentials or embedding", () => {
    expect(management).toHaveProperty("ProviderPatchSchema");
    if (!management) throw new Error("missing management contracts");
    expect(management.ProviderPatchSchema.parse({ models: { chat: "new-model" } })).toEqual({
      models: { chat: "new-model" },
    });
    for (const body of [
      {},
      { api_key: "secret" },
      { models: {} },
      { models: { embedding: "new" } },
      { base_url: "https://user:password@host/v1" },
      { base_url: "https://host/?key=secret" },
      { base_url: "ftp://host" },
      { base_url: "not a url" },
      { protocol: "invalid" },
    ])
      expect(management.ProviderPatchSchema.safeParse(body).success).toBe(false);
    expect(management.ProviderPatchSchema.parse({ name: " New " })).toEqual({ name: "New" });
  });
  it("requires coherent scoped counts and refuses secret fields in public config", () => {
    expect(management).toHaveProperty("ConfigSchema");
    if (!management) throw new Error("missing management contracts");
    const slots = { chat: null, extraction: null, embedding: null };
    const provider = {
      id,
      name: "test",
      protocol: "openai-compatible",
      base_url: "https://host/v1",
      models: {},
      created_at: "2026-10-22T00:00:00Z",
    };
    expect(
      management.ConfigSchema.safeParse({ config_source: "server", providers: [provider], slots })
        .success,
    ).toBe(true);
    expect(
      management.ConfigSchema.safeParse({
        config_source: "server",
        providers: [{ ...provider, apiKeyMasked: "secret" }],
        slots,
      }).success,
    ).toBe(false);
    const status = {
      project: { id, name: "p" },
      conversation: { id, ended_at: null },
      counts: { total: 1, active: 1, deleted: 0, retracted: 0, superseded: 0, expired: 0 },
      slots,
    };
    expect(management.ProjectStatusSchema.safeParse(status).success).toBe(true);
    expect(
      management.ProjectStatusSchema.safeParse({
        ...status,
        counts: { ...status.counts, total: 0 },
      }).success,
    ).toBe(false);
  });
  it("reuses authenticated transport for scoped status, config read and JSON patch", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const api = createApiClient({
      baseUrl: "http://test",
      token: "fake-token",
      fetch,
      timeoutMs: 5000,
    });
    expect(api).toHaveProperty("getProjectStatus");
    await api.getProjectStatus(id, id);
    await api.getConfig();
    await api.updateProvider(id, { models: { chat: "new-model" } });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      `http://test/projects/${id}/status?conversation_id=${id}`,
      "http://test/v1/config",
      `http://test/providers/${id}`,
    ]);
    expect(calls[2]![1].method).toBe("PATCH");
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({ models: { chat: "new-model" } });
    for (const [, init] of calls) {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fake-token");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
