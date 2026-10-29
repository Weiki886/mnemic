import { FeatureFlagSnapshotSchema } from "./flags.js";
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

// 读取兼容历史/手工数据；[0,1] 的业务约束仍由写入 schema 负责。
const score = z.number().finite().nullable();
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

/** 显式手动召回可能调用 embedding；只接收查询，不开放强化/阈值控制。 */
export const RecallRequestSchema = z.object({ query: z.string().trim().min(1).max(1000) }).strict();
const traceCandidate = z
  .object({
    beliefVersionId: z.string().uuid(),
    vectorScore: z.number().finite().nullable(),
    keywordScore: z.number().finite().nullable(),
    fusedScore: z.number().finite(),
    selected: z.boolean(),
    reason: z.enum(["top_k", "below_topk", "below_threshold"]),
  })
  .strict();
export const RecallResultSchema = z
  .object({
    project_id: z.string().uuid(),
    query: z.string().min(1).max(1000),
    abstained: z.boolean(),
    candidates: z
      .array(
        traceCandidate.extend({
          beliefId: z.string().uuid(),
          subject: z.string(),
          attribute: z.string(),
          value: z.unknown().refine((value) => value !== undefined, "值不可缺失"),
        }),
      )
      .max(5),
    trace: z
      .object({
        id: z.string().uuid(),
        reinforce_enabled: z.literal(false),
        flags_snapshot: FeatureFlagSnapshotSchema.nullable().optional(),
        candidate_count: z.number().int().nonnegative(),
        truncated: z.boolean(),
        candidates: z.array(traceCandidate).max(200),
      })
      .strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.trace.flags_snapshot?.flags.read_time_reinforcement)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trace", "flags_snapshot"],
        message: "手动召回快照必须关闭读时强化",
      });
    const shown = r.trace.candidates;
    const selected = shown.filter((c) => c.selected);
    if (
      r.abstained !== (r.candidates.length === 0) ||
      r.trace.candidate_count < shown.length ||
      r.trace.truncated !== r.trace.candidate_count > shown.length ||
      new Set(shown.map((c) => c.beliefVersionId)).size !== shown.length ||
      selected.length !== r.candidates.length ||
      shown.some((c) => c.selected !== (c.reason === "top_k")) ||
      r.candidates.some((c, i) => {
        const s = selected[i];
        return (
          !s ||
          !c.selected ||
          c.reason !== "top_k" ||
          s.beliefVersionId !== c.beliefVersionId ||
          s.vectorScore !== c.vectorScore ||
          s.keywordScore !== c.keywordScore ||
          s.fusedScore !== c.fusedScore
        );
      })
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "召回与轨迹不一致" });
  });
export type RecallResult = z.infer<typeof RecallResultSchema>;
