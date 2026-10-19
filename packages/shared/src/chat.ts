import { z } from "zod";

export const ChatConversationSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  title: z.string().nullable(),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable(),
});
/** 项目会话列表（#8/#31）：沿用会话字段，增加消息数；单页最多 1000 条。 */
export const ConversationListSchema = z
  .array(
    ChatConversationSchema.omit({ project_id: true }).extend({
      message_count: z.number().int().nonnegative(),
    }),
  )
  .max(1000);
export const ChatCommitSchema = ChatConversationSchema.extend({
  extraction_triggered: z.boolean(),
});
export const ChatReplySchema = z.object({
  message_id: z.string().uuid(),
  answer: z.string(),
  abstained: z.boolean(),
  memories: z.array(
    z.object({
      belief_id: z.string().uuid(),
      belief_version_id: z.string().uuid(),
      subject: z.string(),
      attribute: z.string(),
      value: z.unknown(),
    }),
  ),
});
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatCommit = z.infer<typeof ChatCommitSchema>;
export type ChatReply = z.infer<typeof ChatReplySchema>;
