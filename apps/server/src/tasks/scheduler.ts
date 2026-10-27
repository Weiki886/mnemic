import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { enqueueTask } from "./repository.js";
const Schedule = z
  .object({
    projectId: z.string().uuid().toLowerCase(),
    name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    everyMs: z
      .number()
      .int()
      .min(100)
      .max(30 * 86400000),
    startsAt: z
      .date()
      .refine((d) => d.getTime() >= 0)
      .default(() => new Date(0)),
  })
  .strict();
const Schedules = z
  .array(Schedule)
  .max(100)
  .refine(
    (a) => new Set(a.map((s) => `${s.projectId}:${s.name}`)).size === a.length,
    "duplicate task schedule",
  );
export type TaskSchedule = z.input<typeof Schedule>;
type ParsedSchedule = z.infer<typeof Schedule>;
function plans(configs: ParsedSchedule[], at: Date) {
  const now = z.date().parse(at).getTime();
  return configs.flatMap((s) => {
    const start = s.startsAt.getTime();
    if (now < start) return [];
    const bucket = Math.floor((now - start) / s.everyMs);
    return [
      {
        projectId: s.projectId,
        type: "COMPILE_PROFILE" as const,
        payload: {},
        idempotencyKey: `periodic:${s.name}:${s.everyMs}:${start}:${bucket}`,
        runAt: new Date(start + bucket * s.everyMs),
      },
    ];
  });
}
/** Pure schedule specification: one current bucket, no historical replay after downtime. */
export function planPeriodicTasks(configs: unknown, at: Date) {
  return plans(Schedules.parse(configs), at);
}
/** In-memory cursor is an optimization only: DB uniqueness also deduplicates process restarts. */
export function createPeriodicScheduler(db: PostgresJsDatabase, input: unknown) {
  const configs = Schedules.parse(input),
    seen = new Map<string, string>();
  return async (): Promise<number> => {
    if (!configs.length) return 0;
    const [clock] = await db.execute(sql`select clock_timestamp() as now`);
    const at = new Date(clock!.now as string | Date);
    let created = 0;
    for (const [i, config] of configs.entries()) {
      const task = plans([config], at)[0];
      if (!task) continue;
      const name = `${task.projectId}:${task.idempotencyKey}`;
      // Bound cursor by schedule index, not by the ever-growing number of time buckets.
      const cursor = String(i);
      if (seen.get(cursor) === name) continue;
      const result = await enqueueTask(db, task);
      seen.set(cursor, name); // Failed enqueue is retried, never cached as success.
      if (result.created) created++;
    }
    return created;
  };
}
