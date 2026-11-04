import { z } from "zod";
import { ChatReplySchema } from "@mnemic/shared/chat";
import { ConversationMessageViewSchema } from "./conversation.js";

/** Original JSON send path rules: strip unknown keys and normalize both UUIDs. */
export const ChatMessageParamsSchema = z.object({
  projectId: z.string().uuid().toLowerCase(),
  id: z.string().uuid().toLowerCase(),
});

/** Describes HTTP output only; never installed as a response serializer. */
export const JsonChatReplySchema = ChatReplySchema.extend({
  history_included: z.boolean(),
  memories: ConversationMessageViewSchema.shape.memories.unwrap(),
});
