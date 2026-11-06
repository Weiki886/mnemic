import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildRankFusionQuery } from "./fusion.js";
import { candidateInput, unitQueryVector } from "./candidate-input.js";
export type CandidateScore = {
  belief_version_id: string;
  fused_score: string;
  components: {
    route: "vector" | "keyword" | "entity";
    rank: number;
    score: number;
    contribution: number;
  }[];
};
const empty = sql`select null::uuid as belief_version_id,null::float8 as score where false`;
/** Project-scoped, current active version scores only. No model calls, trace writes or mutation. */
export async function readCandidateScores(
  db: Pick<PostgresJsDatabase, "execute">,
  value: unknown,
): Promise<CandidateScore[]> {
  const input = candidateInput(value),
    flags = input.fusion.flags;
  const vectorOn = flags.retrieval_vector && input.embedding !== null;
  const keywordOn = flags.retrieval_keyword && input.query.length > 0;
  const entityOn = flags.retrieval_entity && input.entities.length > 0;
  if (!vectorOn && !keywordOn && !entityOn) return [];
  const limit = input.fusion.perRouteLimit;
  let vector: SQL = empty,
    keyword: SQL = empty,
    entity: SQL = empty;
  if (vectorOn && input.embedding) {
    const literal = unitQueryVector(input.embedding.vector);
    vector = sql`select belief_version_id,max(score) as score from (
    select e.belief_version_id,1-(me.embedding <=> ${literal}::vector) as score
    from eligible e join memory_embeddings me on me.belief_version_id=e.belief_version_id
    where me.model=${input.embedding.model}
  ) raw_vector where score > '-Infinity'::float8 and score < 'Infinity'::float8
    group by belief_version_id order by score desc,belief_version_id limit ${limit}`;
  }
  if (keywordOn)
    keyword = sql`select belief_version_id,score/nullif(max(score) over(),0) as score from (
   select e.belief_version_id,ts_rank(to_tsvector('simple',e.value::text),plainto_tsquery('simple',${input.query}))::float8 as score
   from eligible e where to_tsvector('simple',e.value::text) @@ plainto_tsquery('simple',${input.query})
   order by score desc,e.belief_version_id limit ${limit}
 ) bounded_keyword`;
  if (entityOn) {
    const terms = sql.join(
      input.entities.map((term) => sql`(${term}::text)`),
      sql`,`,
    );
    entity = sql`with wanted as (
    select distinct lower(btrim(normalize(term,NFKC)) collate "C") as term from (values ${terms}) labels(term)
  )
  select e.belief_version_id,count(distinct wanted.term)::float8/(select count(*) from wanted) as score
  from eligible e join observations o on o.id=e.source_observation_id and o.project_id=${input.projectId}::uuid
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.entities)='array' then o.entities else '[]'::jsonb end) label(value)
  join wanted on wanted.term=lower(btrim(normalize(label.value #>> '{}',NFKC)) collate "C")
  where jsonb_typeof(label.value)='string'
  group by e.belief_version_id order by score desc,e.belief_version_id limit ${limit}`;
  }
  const timeFilter = flags.retrieval_time
    ? sql`and bv.valid_from<=${input.validAt}::timestamptz and (bv.valid_to is null or ${input.validAt}::timestamptz < bv.valid_to)`
    : sql``;
  // One SQL statement: source membership and all rank votes share one MVCC statement snapshot.
  const result = await db.execute<CandidateScore>(sql`
   with eligible as (
     select bv.id as belief_version_id,bv.value,bv.source_observation_id
     from beliefs b join belief_versions bv on bv.id=b.current_version_id and bv.belief_id=b.id
     where b.project_id=${input.projectId}::uuid and b.status='active' and bv.recorded_to is null ${timeFilter}
   ), vector_scores as (${vector}), keyword_scores as (${keyword}), entity_scores as (${entity}),
   recall_scores as (
     select belief_version_id,'vector'::text as route,score from vector_scores
     union all select belief_version_id,'keyword'::text,score from keyword_scores
     union all select belief_version_id,'entity'::text,score from entity_scores
   ) ${buildRankFusionQuery(input.fusion)}`);
  return [...result];
}
