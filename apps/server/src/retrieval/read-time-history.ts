import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { MAX_REPLAY_OBSERVATIONS, replayObservationGroup } from "./read-time-replay.js";

const Scope = z
  .object({
    projectId: z.string().uuid().toLowerCase(),
    beliefId: z.string().uuid().toLowerCase(),
    beliefVersionId: z.string().uuid().toLowerCase(),
    authorityEnabled: z.boolean(),
  })
  .strict();
type HistoryRow = {
  id: string;
  projectId: string;
  subject: string;
  attribute: string;
  evidenceId: string;
  value: unknown;
  authority: number;
  assertionIntent: string;
  sourceType: string;
  validTime: string | null;
  recordedAt: string;
  evidenceScopeValid: boolean;
  valueFits: boolean;
};

/** Read-only preparation for #9: never substitute this result under the anchor version's ID. */
export async function readReadTimeReplay(db: Pick<PostgresJsDatabase, "execute">, value: unknown) {
  const parsed = Scope.safeParse(value);
  if (!parsed.success) throw Error("INVALID_READ_TIME_SCOPE");
  const scope = parsed.data; // Detached before the first await.
  let rows;
  try {
    // A single MVCC statement binds the active/current anchor, source and full group history.
    // One extra row detects overflow; never replay a truncated event prefix as complete history.
    rows = await db.execute<HistoryRow>(sql`
      select o.id,o.project_id as "projectId",o.subject,o.attribute,o.evidence_id as "evidenceId",
        case when octet_length(o.value::text)<=16384 then o.value else null end as value,
        octet_length(o.value::text)<=16384 as "valueFits",
        o.authority,o.assertion_intent as "assertionIntent",o.source_type as "sourceType",
        to_char(o.valid_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "validTime",
        to_char(o.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt",
        coalesce(c.project_id=b.project_id,false) as "evidenceScopeValid"
      from beliefs b
      join belief_versions bv on bv.id=b.current_version_id and bv.belief_id=b.id
        and bv.recorded_to is null
      join observations anchor on anchor.id=bv.source_observation_id
        and anchor.project_id=b.project_id and anchor.subject=b.subject and anchor.attribute=b.attribute
      join observations o on o.project_id=b.project_id and o.subject=b.subject and o.attribute=b.attribute
      left join messages m on m.id=o.evidence_id
      left join conversations c on c.id=m.conversation_id
      where b.project_id=${scope.projectId}::uuid and b.id=${scope.beliefId}::uuid
        and bv.id=${scope.beliefVersionId}::uuid and b.status='active'
      order by o.recorded_at,o.id limit ${MAX_REPLAY_OBSERVATIONS + 1}
    `);
  } catch {
    throw Error("READ_TIME_HISTORY_FAILED");
  }
  if (rows.length === 0) return null;
  try {
    if (
      rows.length > MAX_REPLAY_OBSERVATIONS ||
      rows.some((r) => !r.evidenceScopeValid || !r.valueFits)
    )
      throw Error();
    const first = rows[0]!;
    const result = replayObservationGroup({
      group: { projectId: scope.projectId, subject: first.subject, attribute: first.attribute },
      authorityEnabled: scope.authorityEnabled,
      observations: rows.map(({ evidenceScopeValid: _scope, valueFits: _fits, ...o }) => ({
        ...o,
        validTime: o.validTime === null ? null : new Date(o.validTime),
        recordedAt: new Date(o.recordedAt),
      })),
    });
    return { beliefId: scope.beliefId, anchorVersionId: scope.beliefVersionId, ...result };
  } catch {
    throw Error("INVALID_READ_TIME_HISTORY");
  }
}
