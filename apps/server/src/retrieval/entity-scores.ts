import { sql, type SQL } from "drizzle-orm";

/** Internal SQL fragment. Requires an eligible CTE with belief_version_id/source_observation_id.
 * Callers supply scoped current versions and validated terms/query/limit, never SQL identifiers.
 * Explicit terms retain the candidate-reader contract; runtime derives up to32 labels from query.
 */
export function buildEntityScoresQuery(
  projectId: string,
  input: { terms: readonly string[] } | { query: string },
  limit: number,
): SQL {
  const wanted =
    "terms" in input
      ? sql`select distinct lower(btrim(normalize(term,NFKC)) collate "C") as term
        from (values ${sql.join(
          input.terms.map((term) => sql`(${term}::text)`),
          sql`,`,
        )}) labels(term)`
      : sql`select term from labels
        where char_length(term) between 1 and 128 and term !~ '[[:cntrl:]]'
          and strpos(lower(normalize(${input.query}::text,NFKC) collate "C"),term)>0
        order by char_length(term) desc,term collate "C" limit 32`;
  // Collect strings only; JSONB is not a trusted shape or a project-scope proof.
  const discovery =
    "terms" in input
      ? sql``
      : sql`labels as (
    select distinct lower(btrim(normalize(label.value #>> '{}',NFKC)) collate "C") as term
    from eligible e join belief_versions bv on bv.id=e.belief_version_id
    join observations o on o.id=e.source_observation_id and o.project_id=${projectId}::uuid
    cross join lateral jsonb_array_elements(case when jsonb_typeof(o.entities)='array' then o.entities else '[]'::jsonb end) label(value)
    where bv.recorded_to is null and jsonb_typeof(label.value)='string'
  ),`;
  return sql`with ${discovery} wanted as (${wanted})
    select e.belief_version_id,count(distinct wanted.term)::float8/(select count(*) from wanted) as score
    from eligible e join belief_versions bv on bv.id=e.belief_version_id
    join observations o on o.id=e.source_observation_id and o.project_id=${projectId}::uuid
    cross join lateral jsonb_array_elements(case when jsonb_typeof(o.entities)='array' then o.entities else '[]'::jsonb end) label(value)
    join wanted on wanted.term=lower(btrim(normalize(label.value #>> '{}',NFKC)) collate "C")
    where bv.recorded_to is null and jsonb_typeof(label.value)='string'
    group by e.belief_version_id order by score desc,e.belief_version_id limit ${limit}`;
}
