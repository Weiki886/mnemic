import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
export type ModelAdmission = (signal?: AbortSignal) => Promise<void>;
export const DailyCallLimit = z.number().int().min(1).max(1_000_000);
export class ModelQuotaError extends Error {
  readonly statusCode: number;
  constructor(
    readonly reason: "exhausted" | "unavailable",
    readonly retryAfterSeconds: number,
  ) {
    super(
      reason === "exhausted"
        ? "模型调用日配额已用尽，请于 UTC 次日重试"
        : "模型调用配额暂不可用，请稍后重试",
    );
    this.statusCode = reason === "exhausted" ? 429 : 503;
  }
}
const AdmissionResult = z
  .array(
    z.object({ allowed: z.boolean(), retry_after: z.number().int().min(1).max(86400) }).strict(),
  )
  .length(1);
/** Reservations are never refunded: a crash/cancel may consume one without a provider invocation. */
export function createModelQuota(
  db: PostgresJsDatabase,
  limit: number,
  logger?: { warn(message: string): void },
): ModelAdmission {
  const cap = DailyCallLimit.parse(limit);
  const warn = (message: string) => {
    try {
      logger?.warn(message);
    } catch {
      /* A failed logger must not open the gate. */
    }
  };
  return async (signal) => {
    signal?.throwIfAborted();
    let result: z.infer<typeof AdmissionResult>;
    try {
      result = AdmissionResult.parse(
        await db.execute(sql`
        with stamp as materialized (
          select (clock_timestamp() at time zone 'UTC')::date as day
        ), admitted as (
          insert into model_daily_quota(day,calls) select day,1 from stamp
          on conflict(day) do update set calls=model_daily_quota.calls+1
          where model_daily_quota.calls < ${cap}
          returning day
        )
        select exists(select 1 from admitted) as allowed,
          greatest(1,ceil(extract(epoch from ((stamp.day+1)::timestamp at time zone 'UTC')-clock_timestamp())))::int as retry_after
        from stamp
      `),
      );
    } catch {
      warn("model daily quota unavailable");
      throw new ModelQuotaError("unavailable", 60);
    }
    signal?.throwIfAborted();
    if (!result[0]!.allowed) {
      warn("model daily quota exhausted");
      throw new ModelQuotaError("exhausted", result[0]!.retry_after);
    }
  };
}
