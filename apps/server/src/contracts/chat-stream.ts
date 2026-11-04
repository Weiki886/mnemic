import { z } from "zod";
import { ChatStreamEventSchema } from "@mnemic/shared/chat-stream";
import { ChatMessageParamsSchema } from "./chat-message.js";
import { ConversationMessageViewSchema } from "./conversation.js";

export const ChatStreamParamsSchema = ChatMessageParamsSchema;
export const CancelGenerationParamsSchema = ChatStreamParamsSchema.extend({
  generationId: z.string().uuid().toLowerCase(),
});
// The route keeps its existing request.body ?? {} normalization separately.
export const CancelGenerationBodySchema = z.object({}).strict();

const [start, delta, finish, error] = ChatStreamEventSchema.options;
/** Data inside SSE frames, never a JSON response serializer or wire-stream schema. */
export const StreamEventContractSchema = z.discriminatedUnion("type", [
  start,
  delta,
  finish.extend({
    memories: z
      .array(ConversationMessageViewSchema.shape.memories.unwrap().element.strict())
      .max(100),
  }),
  error,
]);
