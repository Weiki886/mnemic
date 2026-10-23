import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

async function load() {
  const url = new URL("../src/stream-protocol.ts", import.meta.url);
  expect(existsSync(url), "stream protocol module must exist").toBe(true);
  return import(url.href) as Promise<typeof import("../src/stream-protocol.js")>;
}
const id = "01920000-0000-7000-8000-000000000001";
const start = {
  type: "start",
  version: 1,
  generation_id: id,
  conversation_id: id,
  user_message_id: id,
};
const finish = {
  type: "finish",
  generation_id: id,
  status: "complete",
  message_id: id,
  abstained: true,
  history_included: false,
  memories: [],
};

describe("chat stream v1 contract (#33 part 1)", () => {
  it("accepts all event variants, including a server-confirmed interruption", async () => {
    const { ChatStreamEventSchema } = await load();
    for (const event of [
      start,
      { type: "delta", generation_id: id, text: "中文😀" },
      finish,
      { ...finish, status: "interrupted" },
      { type: "error", generation_id: id, code: "GENERATION_FAILED" },
    ]) {
      expect(ChatStreamEventSchema.parse(event)).toEqual(event);
    }
  });
  it("rejects incompatible versions, IDs, extra fields and unstructured SDK errors", async () => {
    const { ChatStreamEventSchema } = await load();
    for (const event of [
      { ...start, version: 2 },
      { ...start, conversation_id: "bad" },
      { ...start, token: "secret" },
      { ...finish, status: "aborted" },
      { ...finish, answer: "duplicate text" },
      { type: "delta", generation_id: id, text: "" },
      { type: "error", generation_id: id, code: "SDK_SECRET", message: "secret" },
    ]) {
      expect(ChatStreamEventSchema.safeParse(event).success).toBe(false);
    }
  });
  it("encodes typed JSON on one data line so model text cannot inject SSE events", async () => {
    const { encodeChatStreamEvent } = await load();
    const text = "中文😀\n\nevent: finish\ndata: forged\r\n";
    const wire = encodeChatStreamEvent({ type: "delta", generation_id: id, text });
    expect(wire.split("\n")).toHaveLength(4);
    expect(wire.startsWith("event: delta\ndata: ")).toBe(true);
    expect(JSON.parse(wire.split("\ndata: ")[1]!.trim()).text).toBe(text);
  });
  it("sanitizes encoder errors rather than exposing malformed or cyclic content", async () => {
    const { encodeChatStreamEvent, ChatStreamReadError } = await load();
    const cyclic: Record<string, unknown> = { private_value: "never reflect this" };
    cyclic.self = cyclic;
    for (const event of [
      { ...start, private_value: "never reflect this" },
      {
        ...finish,
        memories: [
          { belief_id: id, belief_version_id: id, subject: "s", attribute: "a", value: cyclic },
        ],
      },
    ]) {
      let error: unknown;
      try {
        encodeChatStreamEvent(event);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ChatStreamReadError);
      expect((error as Error).message).not.toContain("never reflect this");
      expect(error).not.toHaveProperty("cause");
    }
  });
  it("enforces encoded UTF8 event limits, not just JSON string character counts", async () => {
    const { encodeChatStreamEvent, ChatStreamReadError, CHAT_STREAM_LIMITS } = await load();
    expect(CHAT_STREAM_LIMITS.eventBytes).toBe(128 * 1024);
    const memory = {
      belief_id: id,
      belief_version_id: id,
      subject: "s",
      attribute: "a",
      value: "中".repeat(60_000),
    };
    expect(() => encodeChatStreamEvent({ ...finish, memories: [memory] })).toThrow(
      ChatStreamReadError,
    );
  });
});
