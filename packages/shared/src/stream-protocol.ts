import { z } from "zod";
import { ChatReplySchema } from "./chat.js";

export const CHAT_STREAM_LIMITS = Object.freeze({
  eventBytes: 128 * 1024,
  answerBytes: 2 * 1024 * 1024,
  wireBytes: 8 * 1024 * 1024,
  timeoutMs: 120_000,
});
const UUID = z.string().uuid().toLowerCase();
export const ChatStreamCancelSchema = z
  .object({
    generation_id: UUID,
    message_id: UUID,
    status: z.enum(["complete", "interrupted", "failed"]),
  })
  .strict();
export type ChatStreamCancel = z.infer<typeof ChatStreamCancelSchema>;
export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start"),
      version: z.literal(1),
      generation_id: UUID,
      conversation_id: UUID,
      user_message_id: UUID,
    })
    .strict(),
  z
    .object({
      type: z.literal("delta"),
      generation_id: UUID,
      text: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      type: z.literal("finish"),
      generation_id: UUID,
      status: z.enum(["complete", "interrupted"]),
      message_id: UUID,
      abstained: z.boolean(),
      history_included: z.boolean(),
      memories: z.array(ChatReplySchema.shape.memories.element.strict()).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      generation_id: UUID,
      code: z.enum(["GENERATION_FAILED", "PERSISTENCE_FAILED"]),
    })
    .strict(),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;
export type ChatStreamTerminal = Extract<ChatStreamEvent, { type: "finish" | "error" }>;
export interface ChatStreamProgress {
  generationId?: string;
  conversationId?: string;
  userMessageId?: string;
  /** Validated received text, not proof that it was rendered or saved on the server. */
  answer: string;
  terminal?: ChatStreamTerminal;
}
export type ChatStreamErrorCode =
  | "HTTP_ERROR"
  | "INVALID_STREAM"
  | "INCOMPLETE"
  | "ABORTED"
  | "TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "READ_FAILED"
  | "CALLBACK_FAILED"
  | "SERVER_ERROR";

export class ChatStreamReadError extends Error {
  constructor(
    readonly code: ChatStreamErrorCode,
    readonly progress: ChatStreamProgress = { answer: "" },
  ) {
    super(`Chat stream failed (${code}); not retried`);
    this.name = "ChatStreamReadError";
    // Prefixes/citations are private conversation content, not generic error log fields.
    Object.defineProperty(this, "progress", { enumerable: false });
  }
}

/** Validated JSON stays on one data line; model text can never inject event framing. */
export function encodeChatStreamEvent(input: unknown): string {
  try {
    const parsed = ChatStreamEventSchema.safeParse(input);
    if (!parsed.success) throw new ChatStreamReadError("INVALID_STREAM");
    const data = JSON.stringify(parsed.data);
    const wire = `event: ${parsed.data.type}\ndata: ${data}\n\n`;
    if (new TextEncoder().encode(wire).byteLength > CHAT_STREAM_LIMITS.eventBytes)
      throw new ChatStreamReadError("LIMIT_EXCEEDED");
    return wire;
  } catch (error) {
    if (error instanceof ChatStreamReadError) throw error;
    throw new ChatStreamReadError("INVALID_STREAM");
  }
}
