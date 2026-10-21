import { z } from "zod";

/** 当前版本的来源 Observation 类型；缺少可验证来源时为 null，不推测历史类型。 */
export const MemoryTypeSchema = z.enum(["fact", "preference", "decision", "progress"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export const MemoryListQuerySchema = z.object({
  type: MemoryTypeSchema.optional(),
  status: z.enum(["active", "deleted", "retracted", "all"]).default("active"),
  profile: z.enum(["true", "false"]).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
export type MemoryListQuery = z.infer<typeof MemoryListQuerySchema>;

const score = z.number().min(0).max(1).nullable();
export const BeliefListItemSchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  attribute: z.string(),
  type: MemoryTypeSchema.nullable(),
  status: z.enum(["active", "superseded", "expired", "deleted", "retracted"]),
  is_profile: z.boolean(),
  confidence: score,
  salience: score,
  importance: score,
  evidence_count: z.number().int().nonnegative().nullable(),
  created_at: z.string().datetime({ offset: true }),
  current_value: z.unknown().refine((value) => value !== undefined, "当前值字段不可缺失"),
});
export const BeliefListSchema = z.array(BeliefListItemSchema).max(1000);
export type BeliefListItem = z.infer<typeof BeliefListItemSchema>;

export const ForgetResultSchema = z.object({
  id: z.string().uuid().toLowerCase(),
  status: z.literal("deleted"),
});
