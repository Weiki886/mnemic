import { z } from "zod";

/** Configuration contract only. A field's presence is not evidence its owning module is implemented. */
export const FeatureFlagsSchema = z
  .object({
    retrieval_vector: z.boolean(),
    retrieval_keyword: z.boolean(),
    retrieval_entity: z.boolean(),
    retrieval_time: z.boolean(),
    memory_gate: z.boolean(),
    decay: z.boolean(),
    reranker: z.boolean(),
    authority_resolution: z.boolean(),
    read_time_resolution: z.boolean(),
    read_time_reinforcement: z.boolean(),
  })
  .strict();
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze(
  FeatureFlagsSchema.parse({
    retrieval_vector: true,
    retrieval_keyword: true,
    retrieval_entity: false,
    retrieval_time: false,
    memory_gate: true,
    decay: false,
    reranker: false,
    authority_resolution: true,
    read_time_resolution: false,
    read_time_reinforcement: false,
  }),
);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const FeatureFlagSnapshotSchema = z
  .object({ schema_version: z.literal(1), revision, flags: FeatureFlagsSchema })
  .strict();
export const FeatureFlagUpdateSchema = z
  .object({ expected_revision: revision, flags: FeatureFlagsSchema })
  .strict();
export type FeatureFlagSnapshot = Readonly<{
  schema_version: 1;
  revision: number;
  flags: Readonly<FeatureFlags>;
}>;
/** zod clones before freezing. Callers cannot change a snapshot while a model/transaction is awaiting. */
export function createFeatureFlagSnapshot(value: unknown): FeatureFlagSnapshot {
  const parsed = FeatureFlagSnapshotSchema.parse(value);
  Object.freeze(parsed.flags);
  return Object.freeze(parsed);
}

export const FeatureFlagUpdateResultSchema = z
  .object({
    kind: z.enum(["updated", "unchanged", "conflict"]),
    snapshot: FeatureFlagSnapshotSchema,
  })
  .strict();
export type FeatureFlagUpdateResult = Omit<
  z.infer<typeof FeatureFlagUpdateResultSchema>,
  "snapshot"
> & { snapshot: FeatureFlagSnapshot };
export const FeatureFlagHttpUpdateResultSchema = FeatureFlagUpdateResultSchema.extend({
  kind: z.enum(["updated", "unchanged"]),
});
