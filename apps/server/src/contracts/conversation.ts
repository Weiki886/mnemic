import { z } from "zod";
import {
  ChatConversationSchema,
  ChatReplySchema,
  ConversationMessageSchema,
  ChatResumeSchema,
} from "@mnemic/shared/chat";
import { CORRECTIONS_CONVERSATION_TITLE } from "../chat/conversation-titles.js";

/** Existing input rules, shared by handlers/coordinator and contract generation. */
export const ConversationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export const ConversationProjectParamsSchema = z.object({ projectId: z.string().uuid() });
export const ConversationParamsSchema = ConversationProjectParamsSchema.extend({
  id: z.string().uuid(),
});
export const ConversationIdParamsSchema = z.object({ id: z.string().uuid().toLowerCase() });
export const CreateConversationSchema = z.object({
  project_id: z.string().uuid(),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((title) => title !== CORRECTIONS_CONVERSATION_TITLE, "该标题为专用修正会话保留")
    .optional(),
});
export const ResumeBodySchema = z
  .object({ current_conversation_id: z.string().uuid().optional() })
  .strict();

// An arbitrary JSON citation may be null, but it is always an explicit field in HTTP output.
const cited = ChatReplySchema.shape.memories.element.extend({
  value: z.unknown().refine((value) => value !== undefined, "引用值字段不可缺失"),
});
export const ConversationMessageViewSchema = ConversationMessageSchema.extend({
  memories: z.array(cited).nullable(),
});
export const ConversationDetailSchema = ChatConversationSchema.extend({
  messages: z.array(ConversationMessageViewSchema),
});
export const ResumeConversationResponseSchema = ChatResumeSchema.extend({
  messages: z.array(ConversationMessageViewSchema),
});
