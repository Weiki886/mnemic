import { describe, expect, it, vi } from "vitest";
import * as schemas from "../src/chat.js";
import { createApiClient } from "../src/api.js";

const id = "01920000-0000-7000-8000-000000000001";
const other = "01920000-0000-7000-8000-000000000002";
const row = {
  id: other,
  project_id: id,
  title: null,
  started_at: "2026-10-20T00:00:00Z",
  ended_at: null,
  resumed_from: id,
  messages: [
    {
      id,
      speaker: "user",
      raw_text: "继续昨天的工作",
      msg_time: "2026-10-19T00:00:00Z",
      memories: null,
    },
  ],
};

describe("续聊契约（#31）", () => {
  it("恢复响应校验会话、来源和完整消息列表", () => {
    expect(schemas.ChatResumeSchema).toBeDefined();
    expect(schemas.ChatResumeSchema.parse(row)).toEqual(row);
  });
  it.each([
    { ...row, resumed_from: "bad" },
    { ...row, messages: [{ ...row.messages[0], speaker: "system" }] },
    { ...row, messages: [{ ...row.messages[0], id: "bad" }] },
    { ...row, messages: [{ ...row.messages[0], msg_time: "bad" }] },
    { ...row, messages: [{ ...row.messages[0], memories: [{}] }] },
  ])("拒绝畸形恢复响应 %#", (bad) => {
    expect(schemas.ChatResumeSchema).toBeDefined();
    expect(schemas.ChatResumeSchema.safeParse(bad).success).toBe(false);
  });
  it("项目范围 POST，切换时携带当前会话，保留 Bearer 和超时", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(row)));
    const api = createApiClient({
      baseUrl: "https://example.invalid",
      fetch,
      token: "test-token",
      timeoutMs: 1000,
    });
    expect(api.resumeConversation).toBeTypeOf("function");
    await api.resumeConversation(id, other);
    await api.resumeConversation(id, other, id);
    for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toBe(`https://example.invalid/projects/${id}/conversations/${other}/resume`);
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({});
    expect(
      JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({ current_conversation_id: id });
  });
});
