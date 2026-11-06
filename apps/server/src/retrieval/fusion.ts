import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { FeatureFlagsSchema } from "@mnemic/shared/flags";

const common = {
  flags: FeatureFlagsSchema,
  perRouteLimit: z.number().int().min(1).max(200).default(200),
  maxCandidates: z.number().int().min(1).max(800).default(200),
};
const coefficient = z.number().finite().min(0).max(1);
const weights = z
  .object({ vector: coefficient, keyword: coefficient, entity: coefficient, time: coefficient })
  .strict()
  .refine((w) => Math.abs(w.vector + w.keyword + w.entity + w.time - 1) <= 1e-9);
export const RankFusionOptionsSchema = z.discriminatedUnion("mode", [
  z
    .object({ ...common, mode: z.literal("rrf"), k: z.number().int().min(1).max(1000).default(60) })
    .strict(),
  z.object({ ...common, mode: z.literal("weighted"), weights }).strict(),
]);

/**
 * SELECT over the caller's CTE recall_scores(belief_version_id uuid, route text, score float8).
 * No DB/model calls or project eligibility logic; not wired into retrieve() yet (#9 slice1).
 * fused_score is PostgreSQL numeric text: callers must not assume an HTTP number contract.
 */
export function buildRankFusionQuery(value: unknown): SQL {
  const parsed = RankFusionOptionsSchema.safeParse(value);
  if (!parsed.success) throw Error("INVALID_FUSION_OPTIONS");
  const options = parsed.data,
    f = options.flags;
  const contribution =
    options.mode === "rrf"
      ? sql`1::numeric / (${options.k}::numeric + route_rank)`
      : sql`score::numeric * (case route
        when 'vector' then ${options.weights.vector}::numeric
        when 'keyword' then ${options.weights.keyword}::numeric
        when 'entity' then ${options.weights.entity}::numeric
        when 'time' then ${options.weights.time}::numeric
      end)`;
  return sql`
    select belief_version_id, fused_score, components from (
      with fusion_dedup as (
        select belief_version_id,route,max(score) as score
        from recall_scores
        where belief_version_id is not null
          and score > '-Infinity'::float8 and score < 'Infinity'::float8
          and ((route='vector' and ${f.retrieval_vector})
            or (route='keyword' and ${f.retrieval_keyword})
            or (route='entity' and ${f.retrieval_entity})
            or (route='time' and ${f.retrieval_time}))
        group by belief_version_id,route
      ), fusion_ranked as (
        select belief_version_id,route,score,
          row_number() over (partition by route order by score desc,belief_version_id) as route_rank
        from fusion_dedup
      ), fusion_capped as (
        select *,${contribution} as contribution from fusion_ranked
        where route_rank <= ${options.perRouteLimit}
      )
      select belief_version_id,sum(contribution) as fused_score,
        jsonb_agg(jsonb_build_object('route',route,'rank',route_rank,'score',score,'contribution',contribution)
          order by route collate "C") as components
      from fusion_capped group by belief_version_id
    ) fused
    order by fused_score desc,belief_version_id
    limit ${options.maxCandidates}`;
}
