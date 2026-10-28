import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  FeatureFlagUpdateSchema,
  createFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from "@mnemic/shared/flags";
import { featureFlags } from "../db/schema.js";
import { writeAuditLog } from "../gate/audit.js";

type Row = typeof featureFlags.$inferSelect;
function snapshot(row: Row | undefined): FeatureFlagSnapshot {
  if (!row) throw Error("invalid feature flag configuration");
  try {
    return createFeatureFlagSnapshot({
      schema_version: row.schemaVersion,
      revision: row.revision,
      flags: row.flags,
    });
  } catch {
    throw Error("invalid feature flag configuration");
  }
}
/** Singleton server configuration. No behavior reads this repository until subsequent #22 wiring. */
export async function readFeatureFlags(db: PostgresJsDatabase): Promise<FeatureFlagSnapshot> {
  const [row] = await db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.scope, "server"))
    .limit(1);
  return snapshot(row);
}
export type FeatureFlagUpdateResult = {
  kind: "updated" | "unchanged" | "conflict";
  snapshot: FeatureFlagSnapshot;
};
/** Full replacement plus expected revision; lock, change and audit are one DB transaction. */
export async function updateFeatureFlags(
  db: PostgresJsDatabase,
  value: unknown,
): Promise<FeatureFlagUpdateResult> {
  // zod creates a private copy synchronously before the first await.
  const input = FeatureFlagUpdateSchema.parse(value);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.scope, "server"))
      .for("update")
      .limit(1);
    const before = snapshot(row);
    if (before.revision !== input.expected_revision) return { kind: "conflict", snapshot: before };
    if (
      Object.entries(input.flags).every(
        ([key, enabled]) => before.flags[key as keyof typeof input.flags] === enabled,
      )
    )
      return { kind: "unchanged", snapshot: before };
    if (before.revision === Number.MAX_SAFE_INTEGER) throw Error("feature flag revision exhausted");
    const next = createFeatureFlagSnapshot({
      schema_version: 1,
      revision: before.revision + 1,
      flags: input.flags,
    });
    await tx
      .update(featureFlags)
      .set({ revision: next.revision, flags: next.flags, updatedAt: sql`clock_timestamp()` })
      .where(eq(featureFlags.id, row!.id));
    await writeAuditLog(tx, {
      actor: "server",
      action: "flags.update",
      target: "server",
      decision: "updated",
      meta: {
        schema_version: 1,
        previous_revision: before.revision,
        revision: next.revision,
        before: before.flags,
        after: next.flags,
      },
    });
    return { kind: "updated", snapshot: next };
  });
}
