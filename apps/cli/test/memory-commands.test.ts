import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@mnemic/shared";
import { runMemoryCommand } from "../src/memory-commands.js";

const project = "a1920000-0000-7000-8000-000000000001";
const id = "a1920000-0000-7000-8000-000000000002";
const row = {
  id,
  subject: "project\u001b[2J",
  attribute: "db",
  type: "decision",
  status: "active",
  is_profile: false,
  confidence: 0.9,
  salience: null,
  importance: null,
  evidence_count: 1,
  created_at: "2026-10-21T00:00:00Z",
  current_value: "PostgreSQL",
};
const query = { status: "active" as const, limit: 20, offset: 0 };
function fixture(body: unknown, status = 200) {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  const api = createApiClient({
    baseUrl: "https://example.com/api",
    fetch,
    token: "private-token",
    timeoutMs: 120000,
  });
  return { api, fetch };
}

describe("memory command HTTP runner", () => {
  it("uses shared list transport once with scope, filters, bearer and timeout; sanitizes output", async () => {
    const f = fixture([row]);
    const text = await runMemoryCommand(f.api, project.toUpperCase(), {
      kind: "command",
      name: "memory",
      query: { ...query, type: "decision", q: "db %_", limit: 1, offset: 2 },
    });
    expect(f.fetch).toHaveBeenCalledOnce();
    const [raw, init] = f.fetch.mock.calls[0]!;
    const url = new URL(String(raw));
    expect(url.pathname).toBe(`/api/projects/${project}/beliefs`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: "decision",
      status: "active",
      q: "db %_",
      limit: "1",
      offset: "2",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(text).toContain(project);
    expect(text).toContain(id);
    expect(text).toContain("decision");
    expect(text).toContain("PostgreSQL");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("private-token");
  });

  it("soft deletes once through same Web path and validates matching confirmation", async () => {
    const f = fixture({ id: id.toUpperCase(), status: "deleted" });
    expect(
      await runMemoryCommand(f.api, project, {
        kind: "command",
        name: "forget",
        argument: id.toUpperCase(),
      }),
    ).toContain("软删除已确认");
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe(`https://example.com/api/projects/${project}/beliefs/${id}/delete`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it.each([{ id: project, status: "deleted" }, { id, status: "active" }, {}, null])(
    "does not accept false deletion confirmation %#",
    async (body) => {
      const f = fixture(body);
      await expect(
        runMemoryCommand(f.api, project, { kind: "command", name: "forget", argument: id }),
      ).rejects.toThrow("软删除结果未确认");
      expect(f.fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(
    [
      [{ ...row, confidence: "0.900" }],
      [{ ...row, type: undefined }],
      [{ ...row, status: "deleted" }],
      [{ ...row, type: "fact" }],
      [row, row],
    ].map((body) => ({ body })),
  )("rejects incompatible or ignored filters/page size %#", async ({ body }) => {
    const f = fixture(body);
    await expect(
      runMemoryCommand(f.api, project, {
        kind: "command",
        name: "memory",
        query: { ...query, type: "decision", limit: 1 },
      }),
    ).rejects.toThrow("记忆列表读取失败");
  });

  it.each([401, 403, 404, 409, 500])(
    "safe failure %s never prints raw body or repeats request",
    async (status) => {
      const f = fixture({ status, code: "CONFLICT", detail: "private-secret" }, status);
      await expect(
        runMemoryCommand(f.api, project, { kind: "command", name: "forget", argument: id }),
      ).rejects.not.toThrow("private-secret");
      expect(f.fetch).toHaveBeenCalledOnce();
    },
  );
});
