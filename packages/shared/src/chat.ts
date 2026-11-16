import { z } from "zod";
import { FileEvidenceMetadataSchema } from "./file-context.js";

export const ChatConversationSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  title: z.string().nullable(),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable(),
});
/** 项目会话列表（#8/#31）：沿用会话字段，增加消息数；单页最多 1000 条。 */
export const ConversationListItemSchema = ChatConversationSchema.omit({ project_id: true })
  .extend({
    message_count: z.number().int().nonnegative().nullable(),
    history_error: z.literal("unavailable").optional(),
  })
  .refine((row) => (row.message_count === null) === (row.history_error === "unavailable"), {
    message: "未知消息数必须与历史不可用标记同时出现",
  });
export const ConversationListSchema = z.array(ConversationListItemSchema).max(1000);
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;
export const ChatCommitSchema = ChatConversationSchema.extend({
  extraction_triggered: z.boolean(),
});
/** Stored replay citations carry references only; an anchor is not a version of the replayed value. */
export const ReplayMemoryReferenceSchema = z
  .object({
    kind: z.literal("observation_replay"),
    belief_id: z.string().uuid().toLowerCase(),
    anchor_version_id: z.string().uuid().toLowerCase(),
    observation_id: z.string().uuid().toLowerCase(),
    evidence_id: z.string().uuid().toLowerCase(),
  })
  .strict();
export type ReplayMemoryReference = z.infer<typeof ReplayMemoryReferenceSchema>;
export const VersionCitedMemorySchema = z.object({
  belief_id: z.string().uuid(),
  belief_version_id: z.string().uuid(),
  subject: z.string(),
  attribute: z.string(),
  value: z.unknown(),
});
export const ReplayCitedMemorySchema = VersionCitedMemorySchema.extend({
  belief_version_id: z.null(),
  provenance: ReplayMemoryReferenceSchema.omit({ belief_id: true }),
}).strict();
export const CitedMemorySchema = z.union([VersionCitedMemorySchema, ReplayCitedMemorySchema]);
/** SSE has always rejected unknown citation fields, unlike the legacy JSON response parser. */
export const StrictCitedMemorySchema = z.union([
  VersionCitedMemorySchema.strict(),
  ReplayCitedMemorySchema,
]);
export const ChatReplySchema = z.object({
  message_id: z.string().uuid(),
  answer: z.string(),
  abstained: z.boolean(),
  history_included: z.boolean().optional(),
  memories: z.array(CitedMemorySchema),
});
export const ConversationMessageSchema = z.object({
  attachment: FileEvidenceMetadataSchema.optional(),
  generation_status: z.enum(["complete", "interrupted", "failed"]).nullable().optional(),
  id: z.string().uuid(),
  speaker: z.enum(["user", "assistant", "tool"]),
  raw_text: z.string(),
  msg_time: z.string().datetime({ offset: true }),
  memories: ChatReplySchema.shape.memories.nullable(),
});
export const ChatResumeSchema = ChatConversationSchema.extend({
  resumed_from: z.string().uuid(),
  messages: z.array(ConversationMessageSchema),
});
export type CitedMemory = z.infer<typeof ChatReplySchema>["memories"][number];
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type ChatResume = z.infer<typeof ChatResumeSchema>;
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatCommit = z.infer<typeof ChatCommitSchema>;
export type ChatReply = z.infer<typeof ChatReplySchema>;
