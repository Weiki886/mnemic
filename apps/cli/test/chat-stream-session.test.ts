import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@mnemic/shared";
import { ChatSession } from "../src/chat-session.js";
import {
  encodeChatStreamEvent,
  type ChatStreamEvent,
} from "../../../packages/shared/src/stream-protocol.js";

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
const start = {
  type: "start",
  version: 1,
  generation_id: g,
  conversation_id: c,
  user_message_id: project,
} as const;
const finish = (status: "complete" | "interrupted" = "complete"): ChatStreamEvent => ({
  type: "finish",
  generation_id: g,
  status,
  message_id: g,
  abstained: true,
  history_included: true,
  memories: [],
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
      abstained: true,
      memories: [],
    })),
    commitConversation: vi.fn(async (id: string) => ({
      ...row,
      id,
      ended_at: "2026-10-16T01:00:00Z",
      extraction_triggered: false,
    })),
    resumeConversation: vi.fn(async () => ({ ...row, id: g, resumed_from: c, messages: [] })),
    getConversation: vi.fn(async () => ({ ...row, messages: [] })),
    openMessageStream: vi.fn(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    ),
    cancelMessageStream: vi.fn(async () => {
      event(finish("interrupted"));
      return { generation_id: g, message_id: g, status: "interrupted" as const };
    }),
  };
  return { api, event, end: () => controller.close(), session: new ChatSession(api, project) };
}
describe("CLI durable stream lifecycle", () => {
  it("forwards deltas before finish, then returns confirmed metadata without JSON replay", async () => {
    const f = fixture(),
      events: ChatStreamEvent[] = [];
    const job = f.session.send("question", (e) => {
      events.push(e);
    });
    f.event(start);
    f.event({ type: "delta", generation_id: g, text: "实时😀" });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(["start", "delta"]));
    expect(f.session.generating).toBe(true);
    f.event(finish());
    expect(await job).toMatchObject({
      answer: "实时😀",
      history_included: true,
      generation_status: "complete",
    });
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(f.session.generating).toBe(false);
  });
  it("repeated interrupts cancel once, preserve prefix and allow another turn on the same conversation", async () => {
    const f = fixture(),
      events: ChatStreamEvent[] = [];
    const job = f.session.send("first", (e) => {
      events.push(e);
    });
    f.event(start);
    f.event({ type: "delta", generation_id: g, text: "保留片段" });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    f.session.interrupt();
    f.session.interrupt();
    expect(await job).toMatchObject({ answer: "保留片段", generation_status: "interrupted" });
    expect(f.api.cancelMessageStream).toHaveBeenCalledExactlyOnceWith(project, c, g);
    const body = encodeChatStreamEvent(start) + encodeChatStreamEvent(finish());
    f.api.openMessageStream.mockImplementationOnce(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    await f.session.send("continue", () => {});
    expect(f.session.id).toBe(c);
    expect(f.api.createConversation).toHaveBeenCalledOnce();
  });
  it("remembers cancellation requested before start instead of aborting away the save acknowledgement", async () => {
    const f = fixture();
    await f.session.start();
    const job = f.session.send("question", () => {});
    expect(typeof f.session.interrupt).toBe("function");
    f.session.interrupt();
    expect(f.api.cancelMessageStream).not.toHaveBeenCalled();
    f.event(start);
    expect(await job).toMatchObject({ generation_status: "interrupted" });
    expect(f.api.cancelMessageStream).toHaveBeenCalledOnce();
  });
  it("HTTP errors never trigger legacy replay", async () => {
    const f = fixture();
    f.api.openMessageStream.mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED", "secret"));
    await expect(f.session.send("question", () => {})).rejects.toBeInstanceOf(ApiError);
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it("EOF retains prefix, blocks a blind next turn and refuses a misleading commit", async () => {
    const f = fixture();
    const job = f.session.send("question", () => {});
    const rejection = expect(job).rejects.toMatchObject({ progress: { answer: "partial" } });
    f.event(start);
    f.event({ type: "delta", generation_id: g, text: "partial" });
    f.end();
    await rejection;
    await expect(f.session.send("blind replay", () => {})).rejects.toThrow("未确认");
    await expect(f.session.close()).rejects.toThrow("未确认");
    expect(f.api.commitConversation).not.toHaveBeenCalled();
  });
  it("explicit resume clears uncertainty only after a server-confirmed new continuation", async () => {
    const f = fixture();
    const job = f.session.send("question", () => {});
    const rejection = expect(job).rejects.toThrow();
    f.event(start);
    f.end();
    await rejection;
    await f.session.resume(c);
    expect(f.session.id).toBe(g);
    await expect(f.session.close()).resolves.toBeUndefined();
  });
  it("a forged cancel receipt cannot confirm saving; cancellation is bounded", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      expect(typeof f.session.interrupt).toBe("function");
      f.api.cancelMessageStream.mockResolvedValueOnce({
        generation_id: project,
        message_id: project,
        status: "interrupted",
      });
      const job = f.session.send("question", () => {});
      const rejection = expect(job).rejects.toMatchObject({ progress: { answer: "prefix" } });
      f.event(start);
      f.event({ type: "delta", generation_id: g, text: "prefix" });
      await vi.waitFor(() => expect(f.session.generating).toBe(true));
      await vi.advanceTimersByTimeAsync(1);
      f.session.interrupt();
      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
      await expect(f.session.close()).rejects.toThrow("未确认");
    } finally {
      vi.useRealTimers();
    }
  });
  it("an unresponsive cancel request cannot hang the terminal", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      expect(typeof f.session.interrupt).toBe("function");
      f.api.cancelMessageStream.mockImplementationOnce(() => new Promise(() => {}));
      const job = f.session.send("question", () => {});
      const rejection = expect(job).rejects.toThrow();
      f.event(start);
      await vi.advanceTimersByTimeAsync(1);
      f.session.interrupt();
      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
      expect(f.session.generating).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("busy commit 409 is not mistaken for an already archived conversation", async () => {
    const f = fixture();
    await f.session.start();
    f.api.commitConversation.mockRejectedValueOnce(new ApiError(409, "CONFLICT", "busy"));
    await expect(f.session.newConversation()).rejects.toThrow();
    expect(f.session.id).toBe(c);
    expect(f.api.createConversation).toHaveBeenCalledOnce();
  });
});
