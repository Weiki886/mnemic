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
const Anchor = Scope.pick({ beliefId: true, beliefVersionId: true });
const BatchScope = Scope.omit({ beliefId: true, beliefVersionId: true })
  .extend({
    anchors: z.array(Anchor).max(32),
  })
  .strict();
type HistoryRow = {
  position: number;
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

/** Read-only preparation; anchor version IDs never identify replacement values. */
export async function readReadTimeReplay(db: Pick<PostgresJsDatabase, "execute">, value: unknown) {
  const parsed = Scope.safeParse(value);
  if (!parsed.success) throw Error("INVALID_READ_TIME_SCOPE");
  const { projectId, beliefId, beliefVersionId, authorityEnabled } = parsed.data;
  const result = await readReadTimeReplays(db, {
    projectId,
    anchors: [{ beliefId, beliefVersionId }],
    authorityEnabled,
  });
  return result[0] ?? null;
}

/** One MVCC statement for the bounded shortlist; invalid histories reject the entire batch. */
export async function readReadTimeReplays(db: Pick<PostgresJsDatabase, "execute">, value: unknown) {
  // Check cardinality before Zod traverses or copies an arbitrary collection.
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as Record<string, unknown>).anchors) ||
    ((value as Record<string, unknown>).anchors as unknown[]).length > 32
  )
    throw Error("INVALID_READ_TIME_SCOPE");
  const parsed = BatchScope.safeParse(value);
  if (!parsed.success) throw Error("INVALID_READ_TIME_SCOPE");
  const scope = parsed.data;
  if (
    new Set(scope.anchors.map((a) => a.beliefId)).size !== scope.anchors.length ||
    new Set(scope.anchors.map((a) => a.beliefVersionId)).size !== scope.anchors.length
  )
    throw Error("INVALID_READ_TIME_SCOPE");
  if (scope.anchors.length === 0) return [];
  const requested = sql.join(
    scope.anchors.map(
      (a, i) => sql`(${i}::integer,${a.beliefId}::uuid,${a.beliefVersionId}::uuid)`,
    ),
    sql`, `,
  );
  let rows;
  try {
    rows = await db.execute<HistoryRow>(sql`
      with requested(position,belief_id,version_id) as (values ${requested}),
      history as (
        select requested.position,o.*,
          sum(o.value_bytes) over (partition by requested.position) as group_bytes
        from requested
        join beliefs b on b.id=requested.belief_id and b.project_id=${scope.projectId}::uuid and b.status='active'
        join belief_versions bv on bv.id=requested.version_id and bv.id=b.current_version_id
          and bv.belief_id=b.id and bv.recorded_to is null
        join observations anchor on anchor.id=bv.source_observation_id
          and anchor.project_id=b.project_id and anchor.subject=b.subject and anchor.attribute=b.attribute
        cross join lateral (
          select obs.id,obs.project_id as "projectId",obs.subject,obs.attribute,
            obs.evidence_id as "evidenceId",obs.value,octet_length(obs.value::text) as value_bytes,
            obs.authority,obs.assertion_intent as "assertionIntent",obs.source_type as "sourceType",
            to_char(obs.valid_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "validTime",
            to_char(obs.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt",
            obs.recorded_at as sort_time,
            coalesce(c.project_id=b.project_id,false) as "evidenceScopeValid"
          from observations obs
          left join messages m on m.id=obs.evidence_id
          left join conversations c on c.id=m.conversation_id
          where obs.project_id=b.project_id and obs.subject=b.subject and obs.attribute=b.attribute
          order by obs.recorded_at,obs.id limit ${MAX_REPLAY_OBSERVATIONS + 1}
        ) o
      )
      select position,id,"projectId",subject,attribute,"evidenceId",authority,"assertionIntent","sourceType",
        "validTime","recordedAt","evidenceScopeValid",
        case when value_bytes<=16384 and group_bytes<=131072 then value else null end as value,
        value_bytes<=16384 and group_bytes<=131072 as "valueFits"
      from history order by position,sort_time,id
    `);
  } catch {
    throw Error("READ_TIME_HISTORY_FAILED");
  }
  try {
    const groups: HistoryRow[][] = scope.anchors.map(() => []);
    for (const row of rows) groups[row.position]!.push(row);
    return groups.map((group, i) => {
      if (group.length === 0) return null;
      if (
        group.length > MAX_REPLAY_OBSERVATIONS ||
        group.some((r) => !r.evidenceScopeValid || !r.valueFits)
      )
        throw Error();
      const first = group[0]!;
      const result = replayObservationGroup({
        group: { projectId: scope.projectId, subject: first.subject, attribute: first.attribute },
        authorityEnabled: scope.authorityEnabled,
        observations: group.map(
          ({ position: _position, evidenceScopeValid: _scope, valueFits: _fits, ...o }) => ({
            ...o,
            validTime: o.validTime === null ? null : new Date(o.validTime),
            recordedAt: new Date(o.recordedAt),
          }),
        ),
      });
      const anchor = scope.anchors[i]!;
      return {
        projectId: scope.projectId,
        subject: first.subject,
        attribute: first.attribute,
        beliefId: anchor.beliefId,
        anchorVersionId: anchor.beliefVersionId,
        ...result,
      };
    });
  } catch {
    throw Error("INVALID_READ_TIME_HISTORY");
  }
}
