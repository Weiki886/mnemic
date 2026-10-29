import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createFeatureFlagSnapshot, type FeatureFlagSnapshot } from "@mnemic/shared/flags";
import { readFeatureFlags } from "./repository.js";
export interface FeatureFlagOptions {
  /** Trusted effective operation snapshot; never accept it from an HTTP/model payload. */
  flagsSnapshot?: FeatureFlagSnapshot;
}
export const UNSUPPORTED_FEATURE_FLAGS = Object.freeze([
  "retrieval_entity",
  "retrieval_time",
  "decay",
  "reranker",
  "read_time_resolution",
] as const);
/** Freeze once at operation entry. A supplied effective snapshot is final, including reinforcement. */
export async function captureFeatureFlags(
  db: PostgresJsDatabase,
  options: FeatureFlagOptions & { reinforce?: boolean } = {},
): Promise<FeatureFlagSnapshot> {
  const supplied = options.flagsSnapshot
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
  if (UNSUPPORTED_FEATURE_FLAGS.some((key) => snapshot.flags[key]))
    throw Error("unsupported feature flag enabled");
  return snapshot;
}
