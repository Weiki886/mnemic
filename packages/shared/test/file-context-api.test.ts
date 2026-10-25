import { expect, it, vi } from "vitest";
import { createApiClient } from "../src/api.js";
const id = "01920000-0000-7000-8000-000000000001";
const files = [
  { kind: "file" as const, path: "README.md", content: "project data", truncated: false },
];
it("carries attachments through JSON and stream transport without changing existing signal position", async () => {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}"),
  );
  const api = createApiClient({ baseUrl: "http://local", token: "test", fetch });
  await api.sendMessage(id, id, "explain", files);
  const signal = new AbortController().signal;
  await api.openMessageStream(id, id, "explain", signal, files);
  expect(fetch.mock.calls).toHaveLength(2);
  expect(fetch.mock.calls[0]![0]).toBe(`http://local/projects/${id}/conversations/${id}/messages`);
  for (const [, init] of fetch.mock.calls) {
    expect(JSON.parse(init!.body as string)).toEqual({ text: "explain", attachments: files });
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer test");
  }
  expect(fetch.mock.calls[1]![1]?.signal).toBeDefined();
});
it("keeps old message payloads unchanged when attachments are omitted", async () => {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}"),
  );
  const api = createApiClient({ baseUrl: "http://local", fetch });
  await api.sendMessage(id, id, "hi");
  await api.openMessageStream(id, id, "hi");
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
    { text: "hi" },
    { text: "hi" },
  ]);
});
