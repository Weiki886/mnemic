import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  ReplayMemoryReferenceSchema,
  type ReplayMemoryReference,
  type CitedMemory,
} from "@mnemic/shared/chat";
import { beliefs, beliefVersions, observations, messages, conversations } from "../db/schema.js";

type Reference = string | ReplayMemoryReference;
const UUID = z.string().uuid().toLowerCase();

/** JSONB is not a foreign key. Ignore malformed entries, never interpret display content as a ref. */
export function memoryReferences(value: unknown): Reference[] {
  if (!Array.isArray(value)) return [];
  const replayAllowed = value.filter((item) => typeof item !== "string").length <= 32;
  return value.flatMap<Reference>((item) => {
    if (typeof item === "string") {
      const id = UUID.safeParse(item);
      return id.success ? [id.data] : [];
    }
    if (!replayAllowed) return [];
    const replay = ReplayMemoryReferenceSchema.safeParse(item);
    return replay.success ? [replay.data] : [];
  });
}
export function memoryReferenceKey(ref: Reference): string {
  return typeof ref === "string"
    ? ref
    : [ref.kind, ref.belief_id, ref.anchor_version_id, ref.observation_id, ref.evidence_id].join(
        ":",
      );
}

/** At most two batched lookups, no per-message query. Re-resolve original facts, not new replay. */
export async function resolveMemoryReferences(
  db: Pick<PostgresJsDatabase, "select">,
  projectId: string,
  refs: Reference[],
  activeOnly: boolean,
): Promise<Map<string, CitedMemory>> {
  const versionIds = [
    ...new Set(refs.map((ref) => (typeof ref === "string" ? ref : ref.anchor_version_id))),
  ];
  const versions = versionIds.length
    ? await db
        .select({
          belief_version_id: beliefVersions.id,
          belief_id: beliefs.id,
          subject: beliefs.subject,
          attribute: beliefs.attribute,
          value: beliefVersions.value,
        })
        .from(beliefVersions)
        .innerJoin(beliefs, eq(beliefVersions.beliefId, beliefs.id))
        .where(
          and(
            inArray(beliefVersions.id, versionIds),
            eq(beliefs.projectId, projectId),
            activeOnly ? eq(beliefs.status, "active") : undefined,
          ),
        )
    : [];
  const byVersion = new Map(versions.map((row) => [row.belief_version_id, row]));
  const replayRefs = refs.filter((ref): ref is ReplayMemoryReference => typeof ref !== "string");
  const observationIds = [...new Set(replayRefs.map((ref) => ref.observation_id))];
  const rows = observationIds.length
    ? await db
        .select({
          observation_id: observations.id,
          evidence_id: observations.evidenceId,
          belief_id: beliefs.id,
          subject: beliefs.subject,
          attribute: beliefs.attribute,
          value: observations.value,
        })
        .from(observations)
        .innerJoin(
          beliefs,
          and(
            eq(beliefs.projectId, observations.projectId),
            eq(beliefs.subject, observations.subject),
            eq(beliefs.attribute, observations.attribute),
          ),
        )
        .innerJoin(messages, eq(messages.id, observations.evidenceId))
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            inArray(observations.id, observationIds),
            eq(observations.projectId, projectId),
            eq(conversations.projectId, projectId),
            activeOnly ? eq(beliefs.status, "active") : undefined,
          ),
        )
    : [];
  const byObservation = new Map(rows.map((row) => [row.observation_id, row]));
  const result = new Map<string, CitedMemory>();
  for (const ref of refs) {
    if (typeof ref === "string") {
      const row = byVersion.get(ref);
      if (row) result.set(ref, row);
      continue;
    }
    const anchor = byVersion.get(ref.anchor_version_id);
    const source = byObservation.get(ref.observation_id);
    if (
      !anchor ||
      anchor.belief_id !== ref.belief_id ||
      !source ||
      source.belief_id !== ref.belief_id ||
      source.evidence_id !== ref.evidence_id
    )
      continue;
    const { belief_id, subject, attribute, value } = source;
    const { belief_id: _belief, ...provenance } = ref;
    result.set(memoryReferenceKey(ref), {
      belief_id,
      belief_version_id: null,
      subject,
      attribute,
      value,
      provenance,
    });
  }
  return result;
}
