import { z } from "zod";

export const ChatConversationSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  title: z.string().nullable(),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable(),
});
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
