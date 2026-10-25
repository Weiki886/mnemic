import { PassThrough } from "node:stream";
import { once } from "node:events";
import { streamText } from "ai";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  CHAT_STREAM_LIMITS,
  encodeChatStreamEvent,
  type ChatStreamEvent,
} from "@mnemic/shared/chat-stream";
import { abortable, type Generation } from "./generations.js";
import {
  prepareAnswer,
  saveAnswer,
  scheduleMessageWriteback,
  toMemoryRef,
  type EnteredMessage,
  type RespondOptions,
} from "./respond.js";

/** Owns one model call. HTTP close is an interruption only before the persisted terminal decision. */
export function createChatStream(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  entered: EnteredMessage,
  text: string,
  generation: Generation,
  options: RespondOptions,
  timeoutMs = 300_000,
) {
  const output = new PassThrough({ highWaterMark: 16_384 });
  const { signal } = generation.controller;
  let terminal = false;
  const expiresAt = performance.now() + timeoutMs;
  const timer = setTimeout(() => generation.controller.abort(), timeoutMs);
  output.on("close", () => {
    if (!terminal) generation.controller.abort();
  });
  // A stalled final-frame consumer must not hold an HTTP connection forever.
  const transportTimer = setTimeout(() => {
    generation.controller.abort();
    output.destroy();
  }, timeoutMs + 30_000);
  output.once("close", () => clearTimeout(transportTimer));
  output.once("end", () => clearTimeout(transportTimer));
  const active = () => {
    if (performance.now() >= expiresAt) generation.controller.abort();
    if (signal.aborted) throw new Error("generation interrupted");
  };
  let wireBytes = 0,
    answerBytes = 0,
    modelBytes = 0,
    work = 0;
  let answer = "";
  async function cooperate() {
    if (++work % 64 === 0) await abortable(new Promise<void>((r) => setTimeout(r, 0)), signal);
    active();
  }
  async function send(event: ChatStreamEvent) {
    // Admission has already saved the user. Even shutdown before the first token needs a valid start/finish pair.
    if (event.type !== "start") {
      active();
      await cooperate();
    }
    const wire = encodeChatStreamEvent(event);
    wireBytes += Buffer.byteLength(wire);
    if (wireBytes > CHAT_STREAM_LIMITS.wireBytes - CHAT_STREAM_LIMITS.eventBytes)
      throw new Error("stream budget exceeded");
    if (output.destroyed) throw new Error("stream closed");
    const queued = output.write(wire);
    // Commit the prefix synchronously with write(), before waiting for drain (which cancellation may reject).
    if (event.type === "delta") answer += event.text;
    if (!queued) {
      let slowTimer: NodeJS.Timeout | undefined;
      try {
        slowTimer = setTimeout(() => generation.controller.abort(), 30_000);
        await once(output, "drain", { signal });
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
      }
    }
  }
  async function run() {
    let status: "complete" | "interrupted" | "failed" = "complete";
    let prepared: Awaited<ReturnType<typeof prepareAnswer>> | undefined;
    let reader: ReturnType<ReturnType<typeof streamText>["fullStream"]["getReader"]> | undefined;
    try {
      await send({
        type: "start",
        version: 1,
        generation_id: generation.id,
        conversation_id: entered.conversationId,
        user_message_id: entered.userMessageId,
      });
      active();
      prepared = await abortable(prepareAnswer(db, masterKey, text, entered, options), signal);
      active();
      // Validate bounded citation metadata before incurring a model call or promising a finish frame.
      encodeChatStreamEvent({
        type: "finish",
        generation_id: generation.id,
        message_id: generation.id,
        status: "complete",
        abstained: prepared.abstained,
        history_included: prepared.history.length > 0,
        memories: prepared.candidates.map(toMemoryRef),
      });
      const result = streamText({
        model: prepared.model,
        system: prepared.system,
        messages: [...prepared.history, { role: "user", content: prepared.userContent }],
        maxRetries: 0,
        abortSignal: signal,
        onError: () => {},
      });
      reader = result.fullStream.getReader();
      let finished = false;
      while (true) {
        // Reasoning/metadata-only streams must also yield to external cancellation and deadlines.
        await cooperate();
        active();
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        active();
        if (part.value.type === "text-delta" || part.value.type === "reasoning-delta") {
          modelBytes += Buffer.byteLength(part.value.text);
          if (modelBytes > CHAT_STREAM_LIMITS.answerBytes)
            throw new Error("model text budget exceeded");
        }
        if (part.value.type === "error") throw new Error("model failed");
        if (part.value.type === "finish") {
          if (part.value.finishReason === "error") throw new Error("model failed");
          finished = true;
        }
        if (part.value.type !== "text-delta") continue;
        const value = part.value.text;
        answerBytes += Buffer.byteLength(value);
        if (answerBytes > CHAT_STREAM_LIMITS.answerBytes) throw new Error("answer budget exceeded");
        for (let offset = 0; offset < value.length;) {
          let end = Math.min(offset + 16_384, value.length);
          // Keep an encoded Unicode scalar intact at our own framing boundary.
          if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
          const text = value.slice(offset, end);
          offset = end;
          active();
          await send({ type: "delta", generation_id: generation.id, text });
        }
      }
      active();
      if (!finished) throw new Error("model stream incomplete");
    } catch {
      status = signal.aborted ? "interrupted" : "failed";
      generation.controller.abort();
    } finally {
      clearTimeout(timer);
      void reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }

    let persisted = false;
    try {
      persisted = await saveAnswer(
        db,
        entered.conversationId,
        generation.id,
        answer,
        prepared?.candidates ?? [],
        status,
      );
    } catch {
      /* Never forward database exceptions or claim persistence succeeded. */
    }
    terminal = true;
    if (persisted) {
      try {
        await scheduleMessageWriteback(db, masterKey, entered, text, options);
      } catch {
        options.logger?.warn({ generationId: generation.id }, "stream writeback scheduling failed");
      }
    }
    // The cancel endpoint may now read the durable decision, independently of downstream draining.
    generation.finish();
    if (!output.destroyed) {
      const event: ChatStreamEvent =
        !persisted || status === "failed"
          ? {
              type: "error",
              generation_id: generation.id,
              code: persisted ? "GENERATION_FAILED" : "PERSISTENCE_FAILED",
            }
          : {
              type: "finish",
              generation_id: generation.id,
              message_id: generation.id,
              status,
              abstained: prepared?.abstained ?? true,
              history_included: (prepared?.history.length ?? entered.history.length) > 0,
              memories: prepared?.candidates.map(toMemoryRef) ?? [],
            };
      output.end(encodeChatStreamEvent(event));
    }
  }
  // Catch late failures without logging prompt/model/database payloads; always release the lease.
  void run()
    .catch(() => {
      generation.controller.abort();
      generation.finish();
      output.destroy();
    })
    .finally(() => clearTimeout(timer));
  return output;
}
