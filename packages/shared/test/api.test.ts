import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api.js";

/** 类型化 API client（#8）：Web 记忆中心经 packages/shared 调 server API。
 *  fetch 可注入以便单测；错误统一转 ApiError（problem+json → 结构化字段）。 */

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("API client（#8）", () => {
  it("listBeliefs：拼接项目路径与查询参数，解析列表", async () => {
    const f = mockFetch(200, [{ id: "b1", subject: "proj", current_value: "PostgreSQL" }]);
    const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: f });
    const rows = await api.listBeliefs("p1", { status: "all", q: "db", limit: 50, offset: 10 });
    expect(rows[0]!.subject).toBe("proj");
    const url = new URL((f.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe("/projects/p1/beliefs");
    expect(url.searchParams.get("status")).toBe("all");
    expect(url.searchParams.get("q")).toBe("db");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("10");
  });

  it("getBelief / deleteBelief / restoreBelief：方法与路径正确", async () => {
    const f = mockFetch(200, { id: "b1" });
    const api = createApiClient({ baseUrl: "http://localhost:3000/", fetch: f });
    await api.getBelief("p1", "b1");
    await api.deleteBelief("p1", "b1");
    await api.restoreBelief("p1", "b1");
    const calls = f.mock.calls as [string, RequestInit?][];
    expect(calls[0]![0]).toBe("http://localhost:3000/projects/p1/beliefs/b1");
    expect(calls[1]![0]).toBe("http://localhost:3000/projects/p1/beliefs/b1/delete");
    expect(calls[1]![1]?.method).toBe("POST");
    expect(calls[1]![1]?.body).toBeUndefined();
    expect(calls[2]![0]).toBe("http://localhost:3000/projects/p1/beliefs/b1/restore");
    expect(calls[2]![1]?.body).toBeUndefined();
  });

  it("listConversations / getConversation：分页参数与会话详情", async () => {
    const f = mockFetch(200, []);
    const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: f });
    await api.listConversations("p1", { limit: 20, offset: 40 });
    await api.getConversation("p1", "c1");
    const calls = f.mock.calls as [string][];
    const url = new URL(calls[0]![0]);
    expect(url.pathname).toBe("/projects/p1/conversations");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(calls[1]![0]).toBe("http://localhost:3000/projects/p1/conversations/c1");
  });

  it("correctBelief：POST JSON body", async () => {
    const f = mockFetch(200, { beliefId: "b1", route: "updated", relation: "supersede" });
    const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: f });
    const res = await api.correctBelief("b1", "MySQL");
    expect(res.route).toBe("updated");
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ value: "MySQL" });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("listResolutions：消解历史（server 返回 camelCase 键）", async () => {
    const f = mockFetch(200, [{ beliefId: "b1", relation: "supersede", confidenceBefore: 0.8 }]);
    const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: f });
    const rows = await api.listResolutions("b1");
    expect((f.mock.calls[0] as [string])[0]).toBe("http://localhost:3000/beliefs/b1/resolutions");
    expect(rows[0]!.relation).toBe("supersede");
  });

  it("problem+json 错误 → ApiError 带 status/code/errors/requestId", async () => {
    const f = mockFetch(404, {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
      detail: "Belief 不存在：b1",
      requestId: "req-9",
    });
    const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: f });
    const err = await api.getBelief("p1", "b1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("NOT_FOUND");
    expect(apiErr.detail).toBe("Belief 不存在：b1");
    expect(apiErr.requestId).toBe("req-9");
  });

  it("400 带字段级 errors → ApiError.errors 结构化透传", async () => {
    const f = mockFetch(400, {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      code: "VALIDATION_FAILED",
      detail: "参数非法",
      errors: [{ path: "limit", message: "Too big" }],
    });
    const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: f });
    const err = (await api.listBeliefs("p1").catch((e: unknown) => e)) as ApiError;
    expect(err.errors).toEqual([{ path: "limit", message: "Too big" }]);
  });

  it("非 problem+json 错误体 → ApiError 带 status 与原始文本", async () => {
    const f = vi.fn(async () => new Response("upstream exploded", { status: 502 }));
    const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: f });
    const err = (await api.listBeliefs("p1").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.detail).toBe("upstream exploded");
  });
});
