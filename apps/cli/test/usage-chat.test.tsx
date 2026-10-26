import { afterEach, expect, it, vi } from "vitest";
import { render, cleanup } from "ink-testing-library";
import type { ApiClient } from "@mnemic/shared";
import { ChatApp } from "../src/ChatApp.js";
import { ChatSession } from "../src/chat-session.js";
const project = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a",
  id = "0192af91-0000-7000-8000-000000000200";
const metric = { reported: "0", missing_calls: 0 };
afterEach(cleanup);
it("Tab-completed /usage --current queries once inside Ink without sending or committing a message", async () => {
  const api = {
    createConversation: vi.fn(async () => ({
      id,
      project_id: project,
      title: null,
      started_at: "2026-10-01T00:00:00Z",
      ended_at: null,
    })),
    sendMessage: vi.fn(),
    commitConversation: vi.fn(),
    getUsageReport: vi.fn(async () => ({
      project_id: project,
      conversation_id: id,
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-02T00:00:00Z",
      currency: null,
      pricing_revision: null,
      group_by: "day",
      groups_truncated: false,
      groups: [],
      totals: {
        calls: 0,
        success_calls: 0,
        error_calls: 0,
        aborted_calls: 0,
        duration_ms: "0",
        prompt_tokens: metric,
        completion_tokens: metric,
        total_tokens: metric,
        reasoning_tokens: metric,
        cached_input_tokens: metric,
        estimated_cost: { known_amount: null, priced_calls: 0, unpriced_calls: 0 },
      },
    })),
  } as unknown as ApiClient;
  const view = render(
    <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={() => {}} />,
  );
  await vi.waitFor(() => expect(view.lastFrame()).toContain(id));
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain("处理中"));
  view.stdin.write("/usa");
  view.stdin.write("\t");
  view.stdin.write("--current");
  view.stdin.write("\r");
  await vi.waitFor(() => expect(api.getUsageReport).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(view.lastFrame()).toContain("非账单"));
  expect(api.getUsageReport).toHaveBeenCalledWith(
    project,
    expect.objectContaining({ conversation_id: id }),
  );
  expect(api.sendMessage).not.toHaveBeenCalled();
  expect(api.commitConversation).not.toHaveBeenCalled();
});
