import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CHAT_STREAM_LIMITS } from "../src/stream-protocol.js";

async function load() {
  const url = new URL("../src/chat-stream.ts", import.meta.url);
  expect(existsSync(url), "cancellable collector must exist").toBe(true);
  return import(url.href) as Promise<typeof import("../src/chat-stream.js")>;
}
const conversation = "01920000-0000-7000-8000-000000000001";
const generation = "01920000-0000-7000-8000-000000000002";
const user = "01920000-0000-7000-8000-000000000003";
const assistant = "01920000-0000-7000-8000-000000000004";
const start = {
  type: "start",
  version: 1,
  generation_id: generation,
  conversation_id: conversation,
  user_message_id: user,
};
const delta = { type: "delta", generation_id: generation, text: "中文😀" };
const finish = {
  type: "finish",
  generation_id: generation,
  status: "complete",
  message_id: assistant,
  abstained: true,
  history_included: false,
  memories: [],
};
const frame = (event: object, ending = "\n", pretty = false) =>
  `event: ${(event as { type: string }).type}${ending}${JSON.stringify(event, null, pretty ? 2 : 0)
    .split("\n")
    .map((line) => `data: ${line}${ending}`)
    .join("")}${ending}`;
const encoder = new TextEncoder();
function response(chunks: (string | Uint8Array)[], open = false, cancel = vi.fn()) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) {
          const chunk = chunks[index++]!;
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        } else if (!open) controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

describe("cancellable stream collector (#33 part 1)", () => {
  it.each(["complete", "interrupted"] as const)(
    "assembles text and explicit %s acknowledgement without waiting for TCP EOF",
    async (status) => {
      const { consumeChatStream } = await load();
      const cancel = vi.fn();
      const seen: string[] = [];
      const res = response(
        [frame(start) + frame(delta) + frame({ ...finish, status })],
        true,
        cancel,
      );
      const result = await consumeChatStream(res, {
        conversationId: conversation,
        onEvent: (e) => {
          seen.push(e.type);
        },
      });
      expect(result).toEqual({
        status,
        generationId: generation,
        conversationId: conversation,
        userMessageId: user,
        reply: {
          message_id: assistant,
          answer: "中文😀",
          abstained: true,
          history_included: false,
          memories: [],
        },
      });
      expect(seen).toEqual(["start", "delta", "finish"]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(res.body!.locked).toBe(false);
    },
  );
  it("handles every two-chunk UTF8 boundary, BOM, CRLF, multiline JSON, comments and ignored retry fields", async () => {
    const { consumeChatStream } = await load();
    const wire = encoder.encode(
      "\uFEFF: keepalive\r\nid: ignored\r\nretry: 2\r\nextension: ignored\r\n" +
        frame(start, "\r\n", true) +
        frame(delta, "\r\n") +
        frame(finish, "\r\n"),
    );
    for (let i = 1; i < wire.length; i++) {
      const result = await consumeChatStream(response([wire.subarray(0, i), wire.subarray(i)]), {
        conversationId: conversation,
      });
      expect(result.reply.answer, `split ${i}`).toBe("中文😀");
    }
  }, 15000);
  it("accepts a bare-CR terminal delimiter at EOF without inventing missing blank lines", async () => {
    const { consumeChatStream } = await load();
    expect(
      (
        await consumeChatStream(
          response([frame(start, "\r"), frame(delta, "\r"), frame(finish, "\r")]),
          { conversationId: conversation },
        )
      ).reply.answer,
    ).toBe("中文😀");
    await expect(
      consumeChatStream(response([frame(start), frame(finish).trimEnd()]), {
        conversationId: conversation,
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE" });
  });
  it.each(["\r", "\r\n", "\n"])(
    "accepts %j terminal delimiters while the connection remains open",
    async (ending) => {
      const { consumeChatStream } = await load();
      await expect(
        consumeChatStream(response([frame(start, ending) + frame(finish, ending)], true), {
          conversationId: conversation,
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ status: "complete", reply: { message_id: assistant } });
    },
  );
  it.each([false, true])(
    "does not decode invalid bytes after bare-CR terminal (separate chunk: %s)",
    async (separate) => {
      const { consumeChatStream } = await load();
      const wire = encoder.encode(frame(start, "\r") + frame(finish, "\r"));
      const invalid = new Uint8Array([0xff]);
      const chunks = separate ? [wire, invalid] : [new Uint8Array([...wire, ...invalid])];
      await expect(
        consumeChatStream(response(chunks, true), {
          conversationId: conversation,
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ status: "complete" });
    },
  );
  it("retains a prefix on EOF but never claims server-confirmed interruption", async () => {
    const { consumeChatStream } = await load();
    const res = response([frame(start), frame(delta)]);
    await expect(consumeChatStream(res, { conversationId: conversation })).rejects.toMatchObject({
      code: "INCOMPLETE",
      progress: { answer: "中文😀", generationId: generation, userMessageId: user },
    });
    expect(res.body!.locked).toBe(false);
  });
  it.each([
    [frame(delta)],
    [frame(finish)],
    [frame(start), frame(start)],
    [frame({ ...start, conversation_id: user })],
    [frame(start), frame({ ...delta, generation_id: user })],
    [frame(start), frame({ ...finish, generation_id: user })],
    [frame(start), "event: delta\ndata: {broken-json}\n\n"],
    [frame(start), 'event: invented\ndata: {"type":"invented"}\n\n'],
    [frame(start), frame(delta).replace("event: delta", "event: finish")],
    [
      frame(start),
      frame({
        type: "error",
        generation_id: generation,
        code: "GENERATION_FAILED",
        message: "private-upstream-error",
      }),
    ],
  ])("rejects invalid ordering/scope/event contracts (%#)", async (...chunks) => {
    const { consumeChatStream } = await load();
    await expect(
      consumeChatStream(response(chunks), { conversationId: conversation }),
    ).rejects.toMatchObject({ code: "INVALID_STREAM" });
  });
  it("handles a typed server error without logging its private partial conversation", async () => {
    const { consumeChatStream, ChatStreamReadError } = await load();
    const result = await consumeChatStream(
      response([
        frame(start),
        frame(delta),
        frame({ type: "error", generation_id: generation, code: "GENERATION_FAILED" }),
      ]),
      { conversationId: conversation },
    ).catch((e) => e);
    expect(result).toBeInstanceOf(ChatStreamReadError);
    expect(result).toMatchObject({
      code: "SERVER_ERROR",
      progress: { answer: "中文😀", terminal: { type: "error", code: "GENERATION_FAILED" } },
    });
    expect(JSON.stringify(result)).not.toContain("中文😀");
    expect(result).not.toHaveProperty("cause");
  });
  it("cancels pre-aborted bodies without reading events or reflecting signal reasons", async () => {
    const { consumeChatStream } = await load();
    const controller = new AbortController();
    controller.abort("private-signal-reason");
    const cancel = vi.fn();
    const onEvent = vi.fn();
    const res = response([frame(start)], true, cancel);
    const error = await consumeChatStream(res, {
      conversationId: conversation,
      signal: controller.signal,
      onEvent,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: "ABORTED", progress: { answer: "" } });
    expect(error.message).not.toContain("private-signal-reason");
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(res.body!.locked).toBe(false);
  });
  it("interrupts a pending read and releases its lock even if underlying cancel never settles", async () => {
    const { consumeChatStream } = await load();
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const res = response([frame(start), frame(delta)], true, cancel);
    const seen = vi.fn();
    const pending = consumeChatStream(res, {
      conversationId: conversation,
      signal: controller.signal,
      onEvent: seen,
    }).catch((e) => e);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
    controller.abort("private-reason");
    const error = await pending;
    expect(error).toMatchObject({ code: "ABORTED", progress: { answer: "中文😀" } });
    expect(error.progress.terminal).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(res.body!.locked).toBe(false);
  });
  it.each([false, true])(
    "times out stalled %s callback/read without holding the reader lock",
    async (callback) => {
      const { consumeChatStream } = await load();
      const res = response([frame(start)], true);
      const pending = consumeChatStream(res, {
        conversationId: conversation,
        timeoutMs: 15,
        ...(callback ? { onEvent: () => new Promise<void>(() => {}) } : {}),
      });
      await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(res.body!.locked).toBe(false);
    },
  );
  it("awaits asynchronous observers in order and sanitizes their failures", async () => {
    const { consumeChatStream } = await load();
    const order: string[] = [];
    await consumeChatStream(response([frame(start) + frame(delta) + frame(finish)]), {
      conversationId: conversation,
      onEvent: async (event) => {
        order.push(`start:${event.type}`);
        await Promise.resolve();
        order.push(`end:${event.type}`);
      },
    });
    expect(order).toEqual([
      "start:start",
      "end:start",
      "start:delta",
      "end:delta",
      "start:finish",
      "end:finish",
    ]);
    const error = await consumeChatStream(response([frame(start)]), {
      conversationId: conversation,
      onEvent: () => {
        throw new Error("secret-observer-message");
      },
    }).catch((e) => e);
    expect(error.code).toBe("CALLBACK_FAILED");
    expect(error.message).not.toContain("secret-observer-message");
    expect(error).not.toHaveProperty("cause");
  });
  it("preserves a received finish acknowledgement if its observer fails afterward", async () => {
    const { consumeChatStream } = await load();
    const error = await consumeChatStream(response([frame(start), frame(finish)]), {
      conversationId: conversation,
      onEvent: (event) => {
        if (event.type === "finish") throw new Error("observer");
      },
    }).catch((e) => e);
    expect(error).toMatchObject({
      code: "CALLBACK_FAILED",
      progress: { terminal: { type: "finish", status: "complete", message_id: assistant } },
    });
  });
  it("enforces elapsed time even when buffered microtasks prevent the timer callback from running", async () => {
    const { consumeChatStream } = await load();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const res = response([frame(start) + frame(delta) + frame(finish)]);
      await expect(
        consumeChatStream(res, {
          conversationId: conversation,
          timeoutMs: 20,
          onEvent() {
            now = 30;
          },
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(res.body!.locked).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
  it("lets an external abort run even when a source endlessly yields already-buffered empty chunks", async () => {
    const { consumeChatStream } = await load();
    const controller = new AbortController();
    const res = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            stream.enqueue(new Uint8Array());
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(
        consumeChatStream(res, {
          conversationId: conversation,
          signal: controller.signal,
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(res.body!.locked).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });
  it("rejects invalid UTF8 before completion but stops at the first terminal before an invalid suffix", async () => {
    const { consumeChatStream } = await load();
    await expect(
      consumeChatStream(response([encoder.encode(frame(start)), new Uint8Array([0xff])]), {
        conversationId: conversation,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STREAM" });
    const complete = encoder.encode(frame(start) + frame(finish));
    const suffix = new Uint8Array(complete.length + 1);
    suffix.set(complete);
    suffix[complete.length] = 0xff;
    expect(
      (await consumeChatStream(response([suffix], true), { conversationId: conversation })).status,
    ).toBe("complete");
  });
  it("bounds event buffers, accumulated answer and total keepalive traffic", async () => {
    const { consumeChatStream } = await load();
    const giant = "data: " + "x".repeat(CHAT_STREAM_LIMITS.eventBytes + 1);
    const text = { ...delta, text: "a".repeat(16_384) };
    const oversizedAnswer = frame(start) + frame(text).repeat(129);
    const keepalives = (":" + "x".repeat(1024) + "\n").repeat(8200);
    for (const wire of [giant, oversizedAnswer, keepalives]) {
      const res = response([wire], true);
      await expect(consumeChatStream(res, { conversationId: conversation })).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
      });
      expect(res.body!.locked).toBe(false);
    }
  });
  it("rejects bad HTTP/MIME/body/options without parsing private HTTP error bodies", async () => {
    const { consumeChatStream } = await load();
    for (const res of [
      new Response("private-upstream-error", { status: 401 }),
      new Response("{}", { headers: { "content-type": "application/json" } }),
      new Response(null, { headers: { "content-type": "text/event-stream" } }),
    ]) {
      const error = await consumeChatStream(res, { conversationId: conversation }).catch((e) => e);
      expect(["HTTP_ERROR", "INVALID_STREAM"]).toContain(error.code);
      expect(error.message).not.toContain("private-upstream-error");
      expect(res.bodyUsed || res.body === null).toBe(true);
    }
    for (const timeoutMs of [0, -1, NaN, Infinity, 600001]) {
      await expect(
        consumeChatStream(response([]), { conversationId: conversation, timeoutMs }),
      ).rejects.toMatchObject({ code: "INVALID_STREAM" });
    }
  });
  it("retains validated text on a network read failure without exposing the underlying exception", async () => {
    const { consumeChatStream } = await load();
    let sent = false;
    const res = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode(frame(start) + frame(delta)));
            } else controller.error(new Error("private-network-details"));
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
    const error = await consumeChatStream(res, { conversationId: conversation }).catch((e) => e);
    expect(error).toMatchObject({ code: "READ_FAILED", progress: { answer: "中文😀" } });
    expect(error.message).not.toContain("private-network-details");
    expect(res.body!.locked).toBe(false);
  });
});
