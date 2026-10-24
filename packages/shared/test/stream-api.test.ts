import { describe, expect, it, vi } from "vitest";
import { createApiClient, ApiError } from "../src/api.js";

const p = "01920000-0000-7000-8000-000000000001",
  c = "01920000-0000-7000-8000-000000000002",
  g = "01920000-0000-7000-8000-000000000003";
describe("stream transport API", () => {
  it("returns an unread SSE response with scoped URL and authentication, not a JSON request", async () => {
    const response = new Response("event: start\ndata: fixture\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const fetch = vi.fn(async () => response),
      api = createApiClient({ baseUrl: "http://example.invalid/", token: "offline-token", fetch });
    expect(typeof api.openMessageStream).toBe("function");
    const r = await api.openMessageStream(p, c, "raw question");
    expect(r).toBe(response);
    expect(r.bodyUsed).toBe(false);
    expect(fetch.mock.calls).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://example.invalid/projects/${p}/conversations/${c}/messages/stream`);
    expect(JSON.parse(init.body as string)).toEqual({ text: "raw question" });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer offline-token");
  });
  it("stream deadline is 600s despite a short JSON deadline and still obeys external abort", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => new AbortController().signal);
    try {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Response("fixture");
      });
      const api = createApiClient({ baseUrl: "http://example.invalid", timeoutMs: 10, fetch });
      expect(typeof api.openMessageStream).toBe("function");
      await api.openMessageStream(p, c, "question");
      expect(timeout).toHaveBeenCalledWith(600_000);
      expect(timeout).not.toHaveBeenCalledWith(10);
      expect(signals[0]!.aborted).toBe(false);
      const controller = new AbortController();
      await api.openMessageStream(p, c, "question", controller.signal);
      controller.abort();
      expect(signals[1]!.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
  it("cancellation sends one authenticated scoped POST and does not replay errors", async () => {
    const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ generation_id: g, message_id: g, status: "interrupted" })),
      ),
      api = createApiClient({ baseUrl: "http://example.invalid", token: "offline-token", fetch });
    expect(typeof api.cancelMessageStream).toBe("function");
    expect(await api.cancelMessageStream(p, c, g)).toMatchObject({
      generation_id: g,
      status: "interrupted",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/projects/${p}/conversations/${c}/generations/${g}/cancel`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({});
    const denied = createApiClient({
      baseUrl: "http://example.invalid",
      fetch: vi.fn(
        async () => new Response('{"status":401,"code":"UNAUTHORIZED"}', { status: 401 }),
      ),
    });
    expect(typeof denied.openMessageStream).toBe("function");
    await expect(denied.openMessageStream(p, c, "question")).rejects.toBeInstanceOf(ApiError);
  });
  it("pre-aborted stream never initiates a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(),
      api = createApiClient({ baseUrl: "http://example.invalid", fetch });
    expect(typeof api.openMessageStream).toBe("function");
    await expect(api.openMessageStream(p, c, "x", controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
