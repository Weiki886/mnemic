import { randomUUID } from "node:crypto";
import { z } from "zod";
import { REDACTED, sanitizeText } from "../gate/secrets.js";

export const MODEL_DEBUG_MAX_BYTES = 1024 * 1024;
const MAX_PARTS = 2048,
  MAX_MESSAGES = 256,
  MAX_CHUNKS = 8192;
const ContextSchema = z
  .object({
    project_id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    evidence_id: z.string().uuid(),
    provider_name: z.string().max(200),
    model_id: z.string().max(200),
    slot: z.enum(["chat", "extraction"]),
  })
  .strict();
export type ModelDebugContext = z.infer<typeof ContextSchema>;
type TextPart = { type: "text" | "reasoning"; text: string };
type PromptMessage = { role: "system" | "user" | "assistant"; content: string | TextPart[] };
type Reason = "size_limit" | "unsupported" | "cross_boundary_secret" | "incomplete";
type Snapshot =
  | { complete: true; omitted_reason: null; content: PromptMessage[] | TextPart[] }
  | { complete: false; omitted_reason: Reason; content: null };
export type ModelContentRecord = {
  ts: string;
  event: "model.prompt" | "model.response";
  target_id: string;
  detail: ModelDebugContext & Snapshot & { status?: "success" | "error" | "aborted" };
};
export interface ModelCapture {
  output(content: unknown, finishReason: unknown): void;
  part(part: unknown): void;
  finish(status: "success" | "error" | "aborted"): void;
}
export type ModelDebugFactory = (prompt: unknown) => ModelCapture;
export type ModelDebug = (
  context: ModelDebugContext,
  providerKey: string,
) => ModelDebugFactory | undefined;
type Logger = { debug(record: ModelContentRecord, message: string): void };
const omitted = (reason: Reason): Snapshot => ({
  complete: false,
  omitted_reason: reason,
  content: null,
});
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Separate content opt-in: never weaken the metadata-only trace schema or dump SDK envelopes. */
export function createModelDebug(logger?: Logger, credentials: readonly string[] = []): ModelDebug {
  return (input, providerKey) => {
    if (!logger) return; // No context/property inspection while disabled.
    const parsed = ContextSchema.safeParse(input);
    if (!parsed.success) return;
    const secrets = [...new Set([...credentials, providerKey])]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const scrub = (text: string) => {
      for (const secret of secrets) text = text.split(secret).join(REDACTED);
      return sanitizeText(text).text;
    };
    const context: ModelDebugContext = {
      ...parsed.data,
      provider_name: scrub(parsed.data.provider_name),
      model_id: scrub(parsed.data.model_id),
    };

    // Project known text fields only. Never touch image/file data, tool payloads or provider metadata.
    const snapshot = (raw: unknown, isPrompt: boolean): Snapshot => {
      try {
        if (!Array.isArray(raw)) return omitted("unsupported");
        if (raw.length > (isPrompt ? MAX_MESSAGES : MAX_PARTS)) return omitted("size_limit");
        let bytes = 0,
          parts = 0;
        const texts: string[] = [];
        const copyText = (text: unknown) => {
          if (typeof text !== "string") throw "unsupported";
          bytes += Buffer.byteLength(text);
          if (bytes > MODEL_DEBUG_MAX_BYTES) throw "size_limit";
          texts.push(text);
          return scrub(text);
        };
        const copyParts = (value: unknown): TextPart[] => {
          if (!Array.isArray(value)) throw "unsupported";
          parts += value.length;
          if (parts > MAX_PARTS) throw "size_limit";
          return value.map((part: unknown) => {
            if (!object(part) || (part.type !== "text" && part.type !== "reasoning"))
              throw "unsupported";
            return { type: part.type, text: copyText(part.text) };
          });
        };
        const content = isPrompt
          ? raw.map((m: unknown): PromptMessage => {
              if (!object(m)) throw "unsupported";
              if (m.role === "system") return { role: "system", content: copyText(m.content) };
              if (m.role !== "user" && m.role !== "assistant") throw "unsupported";
              return { role: m.role, content: copyParts(m.content) };
            })
          : copyParts(raw);
        // Redaction across field boundaries would require altering their meaning. Omit rather than leak fragments.
        if (scrub(texts.join("")) !== texts.map(scrub).join(""))
          return omitted("cross_boundary_secret");
        return { complete: true, omitted_reason: null, content };
      } catch (reason) {
        return omitted(reason === "size_limit" ? "size_limit" : "unsupported");
      }
    };
    return (prompt) => {
      const invocation = randomUUID();
      const emit = (
        event: ModelContentRecord["event"],
        payload: Snapshot,
        status?: "success" | "error" | "aborted",
      ) => {
        try {
          logger.debug(
            {
              ts: new Date().toISOString(),
              event,
              target_id: invocation,
              detail: { ...context, ...payload, ...(status ? { status } : {}) },
            },
            "model debug content",
          );
        } catch {
          /* A log failure must never retry a paid invocation. */
        }
      };
      emit("model.prompt", snapshot(prompt, true));
      let done = false,
        reason: Reason | undefined,
        stopped = false,
        output: unknown;
      let chunks = 0,
        bytes = 0;
      const blocks: { id: string; type: "text" | "reasoning"; chunks: string[]; ended: boolean }[] =
        [];
      const drop = (r: Reason) => {
        reason ??= r;
        blocks.length = 0;
        output = undefined;
      };
      return {
        output(content, finishReason) {
          if (done) return;
          stopped = finishReason === "stop";
          output = content;
        },
        part(value) {
          if (done) return;
          if (!object(value)) return drop("unsupported");
          const type = value.type;
          if (type === "finish") {
            stopped = value.finishReason === "stop";
            return;
          }
          if (reason) return;
          // These contain no model-authored text. Their metadata and errors are never inspected.
          if (type === "stream-start" || type === "response-metadata" || type === "error") return;
          if (
            type !== "text-start" &&
            type !== "reasoning-start" &&
            type !== "text-delta" &&
            type !== "reasoning-delta" &&
            type !== "text-end" &&
            type !== "reasoning-end"
          )
            return drop("unsupported");
          if (typeof value.id !== "string") return drop("unsupported");
          const blockType = type.startsWith("text-") ? "text" : "reasoning";
          const block = blocks.find((b) => b.id === value.id && b.type === blockType);
          if (type.endsWith("-start")) {
            if (block) return drop("unsupported");
            if (blocks.length >= MAX_PARTS) return drop("size_limit");
            blocks.push({ id: value.id, type: blockType, chunks: [], ended: false });
            return;
          }
          if (!block || block.ended) return drop("unsupported");
          if (type.endsWith("-end")) {
            block.ended = true;
            return;
          }
          if (typeof value.delta !== "string") return drop("unsupported");
          bytes += Buffer.byteLength(value.delta);
          if (++chunks > MAX_CHUNKS || bytes > MODEL_DEBUG_MAX_BYTES) return drop("size_limit");
          block.chunks.push(value.delta);
        },
        finish(status) {
          if (done) return;
          done = true;
          let payload: Snapshot;
          if (status !== "success" || !stopped) payload = omitted("incomplete");
          else if (reason) payload = omitted(reason);
          else if (output !== undefined) payload = snapshot(output, false);
          else if (blocks.some((b) => !b.ended)) payload = omitted("incomplete");
          else
            payload = snapshot(
              blocks.map((b) => ({ type: b.type, text: b.chunks.join("") })),
              false,
            );
          blocks.length = 0;
          output = undefined;
          emit("model.response", payload, status);
        },
      };
    };
  };
}
