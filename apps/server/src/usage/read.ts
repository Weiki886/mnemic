import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  UsageReportSchema,
  UsageExportPageSchema,
  type UsageQuerySchema,
  type UsageExportQuerySchema,
} from "@mnemic/shared/usage";
import type { z } from "zod";
import type { UsagePricing } from "./pricing.js";
import { usageWindow } from "./pricing.js";

export class UsageScopeError extends Error {}
type Query = z.output<typeof UsageQuerySchema>;
type ExportQuery = z.output<typeof UsageExportQuerySchema>;
type Window = ReturnType<typeof usageWindow>;
const fields = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "reasoning_tokens",
  "cached_input_tokens",
] as const;
const noPrices: UsagePricing = { currency: null, rates: [], revision: null };

function selection(project: string, q: { conversation_id?: string | undefined }, w: Window) {
  return sql`u.project_id=${project}::uuid and u.started_at >= ${w.from}::timestamptz and u.started_at < ${w.to}::timestamptz
    ${q.conversation_id ? sql`and u.conversation_id=${q.conversation_id}::uuid` : sql``}`;
}
export async function assertUsageScope(
  db: PostgresJsDatabase,
  project: string,
  conversation?: string,
) {
  const rows = await db.execute(sql`select id from projects where id=${project}::uuid`);
  if (!rows.length) throw new UsageScopeError();
  if (
    conversation &&
    !(
      await db.execute(
        sql`select id from conversations where id=${conversation}::uuid and project_id=${project}::uuid`,
      )
    ).length
  )
    throw new UsageScopeError();
}
function estimate(prices: UsagePricing): SQL {
  if (!prices.rates.length) return sql`null::numeric`;
  const ordered = [...prices.rates].sort(
    (a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from),
  );
  return sql`case ${sql.join(
    ordered.map((r) => {
      const cached = r.cached_input_per_million;
      const input =
        cached === undefined
          ? sql`u.prompt_tokens * ${r.input_per_million}::numeric`
          : sql`case when u.cached_input_tokens between 0 and u.prompt_tokens then
        (u.prompt_tokens-u.cached_input_tokens)*${r.input_per_million}::numeric + u.cached_input_tokens*${cached}::numeric end`;
      const output =
        r.slot === "embedding"
          ? sql`0::numeric`
          : sql`u.completion_tokens * ${r.output_per_million}::numeric`;
      return sql`when u.provider_name=${r.provider_name} and u.model_id=${r.model_id} and u.slot=${r.slot}
      and u.started_at>=${r.effective_from}::timestamptz then ((${input})+(${output}))/1000000::numeric`;
    }),
    sql` `,
  )} else null::numeric end`;
}
const groupExpressions = {
  day: sql`jsonb_build_object('day',to_char(u.started_at at time zone 'UTC','YYYY-MM-DD'))`,
  model: sql`jsonb_build_object('provider_name',u.provider_name,'model_id',u.model_id,'slot',u.slot)`,
  purpose: sql`jsonb_build_object('purpose',u.purpose)`,
  conversation: sql`jsonb_build_object('conversation_id',u.conversation_id)`,
};
function number(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("usage count overflow");
  return n;
}
function totals(r: Record<string, unknown>) {
  const calls = number(r.calls),
    priced = number(r.priced_calls);
  return {
    calls,
    success_calls: number(r.success_calls),
    error_calls: number(r.error_calls),
    aborted_calls: number(r.aborted_calls),
    duration_ms: String(r.duration_ms),
    ...Object.fromEntries(
      fields.map((f) => [
        f,
        { reported: String(r[`sum_${f}`]), missing_calls: calls - number(r[`known_${f}`]) },
      ]),
    ),
    estimated_cost: {
      known_amount: r.known_amount ?? null,
      priced_calls: priced,
      unpriced_calls: calls - priced,
    },
  };
}
function context(
  project: string,
  q: { conversation_id?: string | undefined },
  w: Window,
  p: UsagePricing,
) {
  return {
    project_id: project,
    conversation_id: q.conversation_id ?? null,
    ...w,
    currency: p.currency,
    pricing_revision: p.revision,
  };
}

/** Single SQL snapshot: totals remain complete even when group detail is capped. */
export async function readUsageReport(
  db: PostgresJsDatabase,
  project: string,
  q: Query,
  prices = noPrices,
) {
  const w = usageWindow(q);
  const rows = await db.execute(sql`with measured as (
    select u.*,${estimate(prices)} as amount,${groupExpressions[q.group_by]} as group_key
    from model_usage u where ${selection(project, q, w)}
  ) select grouping(group_key) as is_total,group_key,count(*)::text as calls,
    count(*) filter(where status='success')::text as success_calls,
    count(*) filter(where status='error')::text as error_calls,
    count(*) filter(where status='aborted')::text as aborted_calls,
    coalesce(sum(duration_ms),0)::text as duration_ms,
    ${sql.join(
      fields.map(
        (f) =>
          sql`coalesce(sum(${sql.identifier(f)}),0)::text as ${sql.identifier(`sum_${f}`)}, count(${sql.identifier(f)})::text as ${sql.identifier(`known_${f}`)}`,
      ),
      sql`,`,
    )},
    sum(amount)::numeric(100,12)::text as known_amount,count(amount)::text as priced_calls
    from measured group by grouping sets ((),(group_key)) order by is_total desc,group_key
    limit ${q.group_limit + 2}`);
  return UsageReportSchema.parse({
    ...context(project, q, w, prices),
    group_by: q.group_by,
    totals: totals(rows[0]!),
    groups_truncated: rows.length > q.group_limit + 1,
    groups: rows.slice(1, q.group_limit + 1).map((r) => ({ key: r.group_key, totals: totals(r) })),
  });
}

export async function readUsageExport(
  db: PostgresJsDatabase,
  project: string,
  q: ExportQuery,
  prices = noPrices,
) {
  const w = usageWindow(q),
    where = selection(project, q, w);
  let after = sql``;
  if (q.after) {
    // Preserve PG microseconds: JS Date would truncate the cursor and repeat rows.
    const [cursor] = await db.execute(
      sql`select u.started_at::text as point from model_usage u where ${where} and u.id=${q.after}::uuid`,
    );
    if (!cursor) throw new UsageScopeError();
    after = sql`and (u.started_at,u.id)>(${cursor.point}::timestamptz,${q.after}::uuid)`;
  }
  const rows =
    await db.execute(sql`select u.id,u.conversation_id,u.provider_name,u.model_id,u.slot,u.purpose,u.status,
    to_char(u.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_at,
    u.duration_ms::text,u.prompt_tokens::text,u.completion_tokens::text,u.total_tokens::text,u.reasoning_tokens::text,u.cached_input_tokens::text,
    (${estimate(prices)})::numeric(100,12)::text as estimated_cost
    from model_usage u where ${where} ${after} order by u.started_at,u.id limit ${q.limit + 1}`);
  return UsageExportPageSchema.parse({
    ...context(project, q, w, prices),
    records: rows.slice(0, q.limit),
    next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
  });
}
