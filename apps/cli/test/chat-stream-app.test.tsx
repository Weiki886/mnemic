import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { ChatApp } from "../src/ChatApp.js";
import { ChatSession } from "../src/chat-session.js";
import { encodeChatStreamEvent, type ChatStreamEvent } from "@mnemic/shared/chat-stream";
const project = "01920000-0000-7000-8000-000000000001",
  c = "01920000-0000-7000-8000-000000000002",
  g = "01920000-0000-7000-8000-000000000003";
const row = {
  id: c,
  project_id: project,
  title: null,
  started_at: "2026-10-16T00:00:00Z",
  ended_at: null,
};
const start: ChatStreamEvent = {
  type: "start",
  version: 1,
  generation_id: g,
  conversation_id: c,
  user_message_id: project,
};
const finish = (status: "complete" | "interrupted" = "complete"): ChatStreamEvent => ({
  type: "finish",
  generation_id: g,
  status,
  message_id: g,
  abstained: false,
  history_included: true,
  memories: [
    { belief_id: project, belief_version_id: g, subject: "s", attribute: "a", value: "v" },
  ],
});
function fixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const event = (e: ChatStreamEvent) =>
    controller.enqueue(new TextEncoder().encode(encodeChatStreamEvent(e)));
  const api = {
    createConversation: vi.fn(async () => row),
    sendMessage: vi.fn(async () => ({
      message_id: g,
      answer: "legacy",
      abstained: false,
      memories: [],
    })),
    commitConversation: vi.fn(async () => ({
      ...row,
      ended_at: "2026-10-16T01:00:00Z",
      extraction_triggered: false,
    })),
    resumeConversation: vi.fn(),
    getConfig: vi.fn(),
    getProjectStatus: vi.fn(),
    updateProvider: vi.fn(),
    recallBeliefs: vi.fn(),
    listBeliefs: vi.fn(),
    deleteBelief: vi.fn(),
    openMessageStream: vi.fn(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    ),
    cancelMessageStream: vi.fn(async () => {
      event(finish("interrupted"));
      return { generation_id: g, message_id: g, status: "interrupted" as const };
    }),
  };
  const done = vi.fn(),
    view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
    );
  const send = async (text: string) => {
    view.stdin.write(text);
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`> ${text}`));
    view.stdin.write("\r");
  };
  return { api, event, done, view, send, end: () => controller.close() };
}
afterEach(cleanup);
describe("Ink real streaming", () => {
  it("a valid cancel receipt followed by EOF is saved but not falsely presented as a complete answer", async () => {
    const f = fixture();
    f.api.cancelMessageStream.mockImplementationOnce(async () => ({
      generation_id: g,
      message_id: g,
      status: "interrupted",
    }));
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(c));
    await f.send("question");
    await vi.waitFor(() => expect(f.api.openMessageStream).toHaveBeenCalledOnce());
    f.event(start);
    f.event({ type: "delta", generation_id: g, text: "收到的部分" });
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("收到的部分"));
    f.view.stdin.write("\u001b");
    await vi.waitFor(() => expect(f.api.cancelMessageStream).toHaveBeenCalledOnce());
    f.end();
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("已保存 · 输出未完成"));
    expect(f.view.frames.join("\n")).not.toContain("保存未确认");
    expect(f.view.frames.join("\n")).not.toContain("已中断 · 已保存");
  });
  it.each(["\u001b", "\u0003"])(
    "key %j cancels a live turn without exiting; continued input uses the same conversation",
    async (key) => {
      const f = fixture();
      await vi.waitFor(() => expect(f.view.lastFrame()).toContain(c));
      await f.send("first");
      await vi.waitFor(() => expect(f.api.openMessageStream).toHaveBeenCalledOnce());
      f.event(start);
      f.event({ type: "delta", generation_id: g, text: "可见前缀😀\u001b[2J\u202e" });
      await vi.waitFor(() => expect(f.view.lastFrame()).toContain("可见前缀😀"));
      expect(f.api.cancelMessageStream).not.toHaveBeenCalled();
      expect(f.view.lastFrame()).not.toContain("\u001b[2J");
      expect(f.view.lastFrame()).not.toContain("\u202e");
      f.view.stdin.write(key);
      await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("已中断 · 已保存"));
      expect(f.done).not.toHaveBeenCalled();
      expect(f.api.commitConversation).not.toHaveBeenCalled();
      const wire =
        encodeChatStreamEvent(start) +
        encodeChatStreamEvent({ type: "delta", generation_id: g, text: "下一轮" }) +
        encodeChatStreamEvent(finish());
      f.api.openMessageStream.mockImplementationOnce(
        async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
      );
      await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
      await f.send("continue");
      await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("下一轮"));
      expect(f.api.createConversation).toHaveBeenCalledOnce();
      expect(f.api.sendMessage).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
      f.view.stdin.write("\u0003");
      await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(0));
      expect(f.api.commitConversation).toHaveBeenCalledOnce();
    },
  );
  it("EOF leaves the validated prefix visibly unconfirmed without exposing errors or replaying", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(c));
    await f.send("question");
    await vi.waitFor(() => expect(f.api.openMessageStream).toHaveBeenCalledOnce());
    f.event(start);
    f.event({ type: "delta", generation_id: g, text: "未完文本" });
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("未完文本"));
    f.end();
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("保存未确认"));
    expect(f.view.frames.join("\n")).toContain("未完文本");
    expect(f.api.openMessageStream).toHaveBeenCalledOnce();
    expect(f.done).not.toHaveBeenCalled();
  });
});
