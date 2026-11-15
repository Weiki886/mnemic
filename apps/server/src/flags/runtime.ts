import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createFeatureFlagSnapshot, type FeatureFlagSnapshot } from "@mnemic/shared/flags";
import { readFeatureFlags } from "./repository.js";
export interface FeatureFlagOptions {
  /** Trusted effective operation snapshot; never accept it from an HTTP/model payload. */
  flagsSnapshot?: FeatureFlagSnapshot;
}
export const UNSUPPORTED_FEATURE_FLAGS = Object.freeze([
  "decay",
  "reranker",
  "read_time_resolution",
] as const);
/** Freeze once at operation entry. A supplied effective snapshot is final, including reinforcement. */
export async function captureFeatureFlags(
  db: PostgresJsDatabase,
  options: FeatureFlagOptions & { reinforce?: boolean } = {},
  capabilities: { reranker?: boolean; operation?: "memory_write" } = {},
): Promise<FeatureFlagSnapshot> {
  // A valid internal retrieval binding may support this operation; it does not enable the flag.
  // A retrieval-only flag is recorded, but not executed or required, by a memory write.
  const acceptsRerankerFlag =
    capabilities.reranker === true || capabilities.operation === "memory_write";
  const supplied =
    options.flagsSnapshot !== undefined
      ? createFeatureFlagSnapshot(options.flagsSnapshot)
      : undefined;
  const override =
    options.reinforce ??
    (process.env.MNEMIC_READ_REINFORCE !== undefined
      ? process.env.MNEMIC_READ_REINFORCE === "1"
      : undefined);
  const stored = supplied ?? (await readFeatureFlags(db));
  const snapshot =
    !supplied && override !== undefined
      ? createFeatureFlagSnapshot({
          ...stored,
          flags: { ...stored.flags, read_time_reinforcement: override },
        })
      : stored;
  if (
    UNSUPPORTED_FEATURE_FLAGS.some(
      (key) => snapshot.flags[key] && !(key === "reranker" && acceptsRerankerFlag),
    )
  )
    throw Error("unsupported feature flag enabled");
  return snapshot;
}
