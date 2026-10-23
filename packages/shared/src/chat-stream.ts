import { createParser } from "eventsource-parser";
import type { ChatReply } from "./chat.js";
import { ChatConversationSchema } from "./chat.js";
import {
  CHAT_STREAM_LIMITS,
  ChatStreamEventSchema,
  ChatStreamReadError,
  type ChatStreamErrorCode,
  type ChatStreamEvent,
  type ChatStreamProgress,
} from "./stream-protocol.js";
export * from "./stream-protocol.js";

export interface ChatStreamResult {
  status: "complete" | "interrupted";
  generationId: string;
  conversationId: string;
  userMessageId: string;
  reply: ChatReply;
}
export interface ChatStreamOptions {
  conversationId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: ChatStreamEvent) => void | Promise<void>;
}

/** Collects an already fetched response; never fetches, retries or claims that local abort persisted data. */
export async function consumeChatStream(
  response: Response,
  options: ChatStreamOptions,
): Promise<ChatStreamResult> {
  const progress: ChatStreamProgress = { answer: "" };
  const fail = (code: ChatStreamErrorCode) => new ChatStreamReadError(code, { ...progress });
  const deadline = new AbortController();
  const timedOut = Symbol("stream deadline");
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const abortError = () => fail(signal.reason === timedOut ? "TIMEOUT" : "ABORTED");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiresAt = Infinity;
  const checkActive = () => {
    // Buffered streams can keep scheduling microtasks ahead of timers; check monotonic time too.
    if (!signal.aborted && performance.now() >= expiresAt) deadline.abort(timedOut);
    if (signal.aborted) throw abortError();
  };
  const cancel = () => {
    // An underlying cancel implementation may never settle; do not let it hold up interruption.
    const task = reader
      ? reader.cancel()
      : response.body && !response.body.locked
        ? response.body.cancel()
        : undefined;
    void task?.catch(() => {});
  };
  function wait<T>(task: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(abortError());
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      // Always attach both handlers, even if already aborted, so late task rejection stays handled.
      task.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
  let workUnits = 0;
  async function cooperate() {
    // Even an in-memory stream of empty chunks must let keyboard/abort/timer tasks run.
    if (++workUnits % 64 !== 0) return;
    let turn: ReturnType<typeof setTimeout> | undefined;
    try {
      await wait(
        new Promise<void>((resolve) => {
          turn = setTimeout(resolve, 0);
        }),
      );
    } finally {
      if (turn !== undefined) clearTimeout(turn);
    }
  }
  try {
    if (signal.aborted) throw abortError();
    const conversation = ChatConversationSchema.shape.id.safeParse(options.conversationId);
    const timeoutMs = options.timeoutMs ?? CHAT_STREAM_LIMITS.timeoutMs;
    if (
      !conversation.success ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 600_000
    )
      throw fail("INVALID_STREAM");
    if (response.status !== 200) throw fail("HTTP_ERROR");
    if (
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "text/event-stream" ||
      !response.body ||
      response.body.locked
    )
      throw fail("INVALID_STREAM");
    reader = response.body.getReader();
    expiresAt = performance.now() + timeoutMs;
    timer = setTimeout(() => deadline.abort(timedOut), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    const queue: ChatStreamEvent[] = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let wireBytes = 0,
      answerBytes = 0;
    let skipLF = false;
    const parser = createParser({
      maxBufferSize: CHAT_STREAM_LIMITS.eventBytes,
      onError(error) {
        if (!progress.terminal && error.type === "max-buffer-size-exceeded")
          throw fail("LIMIT_EXCEEDED");
        // Comments/id/retry/unknown SSE fields are not application events and never trigger replay.
      },
      onEvent(message) {
        if (progress.terminal) return;
        if (
          encoder.encode(`event: ${message.event}\ndata: ${message.data}\n\n`).byteLength >
          CHAT_STREAM_LIMITS.eventBytes
        )
          throw fail("LIMIT_EXCEEDED");
        let parsed;
        try {
          parsed = ChatStreamEventSchema.safeParse(JSON.parse(message.data));
        } catch {
          throw fail("INVALID_STREAM");
        }
        if (!parsed.success || message.event !== parsed.data.type) throw fail("INVALID_STREAM");
        const event = parsed.data;
        if (event.type === "start") {
          if (progress.generationId || event.conversation_id !== conversation.data.toLowerCase())
            throw fail("INVALID_STREAM");
          progress.generationId = event.generation_id;
          progress.conversationId = event.conversation_id;
          progress.userMessageId = event.user_message_id;
        } else {
          if (!progress.generationId || event.generation_id !== progress.generationId)
            throw fail("INVALID_STREAM");
          if (event.type === "delta") {
            answerBytes += encoder.encode(event.text).byteLength;
            if (answerBytes > CHAT_STREAM_LIMITS.answerBytes) throw fail("LIMIT_EXCEEDED");
            progress.answer += event.text;
          } else progress.terminal = event;
        }
        queue.push(event);
      },
    });
    async function drain() {
      for (const event of queue.splice(0)) {
        checkActive();
        if (options.onEvent) {
          try {
            // An observer may mutate its copy; it must not corrupt internal IDs or final acknowledgements.
            await wait(Promise.resolve().then(() => options.onEvent!(structuredClone(event))));
          } catch {
            if (signal.aborted) throw abortError();
            throw fail("CALLBACK_FAILED");
          }
        }
        checkActive();
      }
    }
    function feed(text: string) {
      if (!text) return;
      // A CR already ends the line; suppress only its optional following LF, even across chunks.
      // Normalize before parsing so a CR-delimited terminal never waits for another byte or EOF.
      if (skipLF) {
        skipLF = false;
        if (text.startsWith("\n")) text = text.slice(1);
      }
      if (!text) return;
      skipLF = text.endsWith("\r");
      try {
        parser.feed(text.replace(/\r\n?/g, "\n"));
      } catch (error) {
        if (error instanceof ChatStreamReadError) throw error;
        throw fail("INVALID_STREAM");
      }
    }
    while (!progress.terminal) {
      await cooperate();
      checkActive();
      let chunk;
      try {
        chunk = await wait(reader.read());
      } catch {
        if (signal.aborted) throw abortError();
        throw fail("READ_FAILED");
      }
      checkActive();
      if (chunk.done) {
        try {
          feed(decoder.decode());
        } catch (error) {
          if (error instanceof ChatStreamReadError) throw error;
          throw fail("INVALID_STREAM");
        }
        await drain();
        if (!progress.terminal) throw fail("INCOMPLETE");
        break;
      }
      for (let offset = 0; offset < chunk.value.byteLength && !progress.terminal;) {
        await cooperate();
        checkActive();
        let slice = chunk.value.subarray(offset, offset + 16_384);
        // Feed at line boundaries so logical EOF is recognized before decoding a trailing invalid suffix.
        const end = slice.findIndex((byte) => byte === 10 || byte === 13);
        if (end >= 0) slice = slice.subarray(0, end + 1);
        offset += slice.byteLength;
        wireBytes += slice.byteLength;
        if (wireBytes > CHAT_STREAM_LIMITS.wireBytes) throw fail("LIMIT_EXCEEDED");
        try {
          feed(decoder.decode(slice, { stream: true }));
        } catch (error) {
          if (error instanceof ChatStreamReadError) throw error;
          throw fail("INVALID_STREAM");
        }
        await drain();
      }
    }
    checkActive();
    const terminal = progress.terminal;
    if (!terminal || terminal.type === "error") throw fail("SERVER_ERROR");
    return {
      status: terminal.status,
      generationId: progress.generationId!,
      conversationId: progress.conversationId!,
      userMessageId: progress.userMessageId!,
      reply: {
        message_id: terminal.message_id,
        answer: progress.answer,
        abstained: terminal.abstained,
        history_included: terminal.history_included,
        memories: terminal.memories,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}
