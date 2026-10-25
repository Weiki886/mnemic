import { expect, it, vi } from "vitest";
import { createApiClient } from "../src/api.js";
it("queries project usage with bounded filters and exports authenticated JSON pages", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  const api = createApiClient({ baseUrl: "https://example.invalid", token: "offline", fetch });
  await api.getUsageReport("p", {
    conversation_id: "c",
    from: "2026-10-01T00:00:00Z",
    group_by: "model",
  });
  await api.exportUsage("p", { after: "last", limit: 2 });
  const calls = fetch.mock.calls as [string, RequestInit][];
  const report = new URL(calls[0]![0]),
    page = new URL(calls[1]![0]);
  expect(report.pathname).toBe("/projects/p/usage");
  expect(report.searchParams.get("conversation_id")).toBe("c");
  expect(report.searchParams.get("from")).toBe("2026-10-01T00:00:00Z");
  expect(page.pathname).toBe("/projects/p/usage/export");
  expect(page.searchParams.get("format")).toBe("json");
  expect(page.searchParams.get("after")).toBe("last");
  expect(
    calls.every(([, init]) => new Headers(init.headers).get("authorization") === "Bearer offline"),
  ).toBe(true);
});
