import { z } from "zod";
import { BeliefListItemSchema, MemoryListQuerySchema } from "@mnemic/shared/memory";
import { FeatureFlagSnapshotSchema } from "@mnemic/shared/flags";

/** Existing runtime input rules; object extras are stripped, not rejected. */
export const ProjectParamsSchema = z.object({ projectId: z.string().uuid() });
export const BeliefParamsSchema = ProjectParamsSchema.extend({ id: z.string().uuid() });
export const BeliefListQuerySchema = MemoryListQuerySchema.extend({
  // Server/Web default differs deliberately from the shared CLI default of 20.
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export const CorrectBodySchema = z.object({ value: z.string().min(1) });

// JSONB may hold any JSON value, including null; a missing property is not a value.
const value = z.unknown().refine((v) => v !== undefined, "值字段不可缺失");
const id = z.string().uuid();
const time = z.string().datetime({ offset: true });
const score = z.number().finite().nullable();
const relation = z.enum(["strengthen", "weaken", "extend", "supersede"]).nullable();
export const BeliefVersionSchema = z.object({
  id,
  value,
  valid_from: time.nullable(),
  valid_to: time.nullable(),
  recorded_from: time,
  recorded_to: time.nullable(),
  supersedes_version_id: id.nullable(),
  confidence: score,
  resolver_version: z.string().nullable(),
  source: z
    .object({ observation_id: id, message_id: id.nullable(), conversation_id: id.nullable() })
    .nullable(),
});
export const BeliefDetailSchema = BeliefListItemSchema.omit({ type: true }).extend({
  project_id: id,
  current_value: value,
  versions: z.array(BeliefVersionSchema),
});
export const BeliefStatusResultSchema = z.object({ id, status: z.enum(["active", "deleted"]) });
export const CorrectResultSchema = z.object({
  beliefId: id.nullable(),
  route: z.enum(["created", "merged", "skipped", "conflict"]),
  relation,
});
export const ResolutionTraceSchema = z.object({
  id,
  projectId: id,
  beliefId: id,
  observationId: id,
  previousVersionId: id.nullable(),
  resultVersionId: id.nullable(),
  relation,
  confidenceBefore: score,
  confidenceAfter: score,
  policies: value,
  modelSnapshot: value,
  flagsSnapshot: FeatureFlagSnapshotSchema.nullable(),
  resolverVersion: z.string(),
  createdAt: time,
});
