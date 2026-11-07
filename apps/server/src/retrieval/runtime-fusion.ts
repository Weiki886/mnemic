import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FeatureFlags } from "@mnemic/shared/flags";
import { z } from "zod";
import { RankFusionOptionsSchema } from "./fusion.js";
import { buildCandidateScoresQuery, type CandidateScore } from "./candidates.js";
import type { RetrievalCandidate } from "./search.js";

// Reuse the SQL fusion contract; callers cannot override the operation's frozen flags.
const threshold = z.number().finite().min(0).max(1);
const Request = z.discriminatedUnion("mode", [
  RankFusionOptionsSchema.options[0].omit({ flags: true }).extend({ threshold }),
  RankFusionOptionsSchema.options[1].omit({ flags: true }).extend({ threshold }),
]);
export type RuntimeFusion = z.infer<typeof Request>;
export function parseRuntimeFusion(value: unknown): RuntimeFusion | undefined {
  if (value === undefined) return undefined;
  const parsed = Request.safeParse(value);
  if (!parsed.success) throw Error("INVALID_RUNTIME_FUSION_OPTIONS");
  return parsed.data;
}

/** One read-only SQL statement: ranking and hydration share a single MVCC snapshot. */
export async function readFusedCandidates(
  db: Pick<PostgresJsDatabase, "execute">,
  projectId: string,
  query: string,
  flags: Readonly<FeatureFlags>,
  fusion: RuntimeFusion,
  embedding: { model: string; vector: number[] } | null,
) {
  const { threshold: _threshold, ...config } = fusion;
  const scores = buildCandidateScoresQuery({
    projectId,
    query,
    embedding,
    fusion: { ...config, flags },
  });
  const details = new Map<string, CandidateScore["components"]>();
  if (!scores) return { candidates: [] as RetrievalCandidate[], details };
  const rows = await db.execute<{
    belief_id: string;
    belief_version_id: string;
    subject: string;
    attribute: string;
    value: unknown;
    fused_score: string;
    components: CandidateScore["components"];
  }>(sql`
    with fused as (${scores})
    select b.id as belief_id,bv.id as belief_version_id,b.subject,b.attribute,bv.value,
           fused.fused_score,fused.components
    from fused join belief_versions bv on bv.id=fused.belief_version_id
    join beliefs b on b.id=bv.belief_id and b.current_version_id=bv.id
    where b.project_id=${projectId}::uuid and b.status='active' and bv.recorded_to is null
    order by fused.fused_score desc,bv.id
  `);
  const candidates = rows.map((row): RetrievalCandidate => {
    details.set(row.belief_version_id, row.components);
    return {
      beliefId: row.belief_id,
      beliefVersionId: row.belief_version_id,
      subject: row.subject,
      attribute: row.attribute,
      value: row.value,
      vectorScore: row.components.find((c) => c.route === "vector")?.score ?? null,
      keywordScore: row.components.find((c) => c.route === "keyword")?.score ?? null,
      fusedScore: Number(row.fused_score),
      selected: false,
      reason: "below_threshold",
    };
  });
  return { candidates, details };
}
