import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import {
  beliefs,
  beliefVersions,
  conversations,
  memoryTasks,
  messages,
  projects,
} from "../db/schema.js";

const uuid = z.string().uuid().toLowerCase();
const common = {
  projectId: uuid,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  maxAttempts: z.number().int().min(1).max(100).default(5),
  backoffBaseMs: z.number().int().min(1).max(86400000).default(1000),
  backoffCapMs: z.number().int().min(1).max(86400000).default(60000),
  runAt: z.date().optional(),
};
const Input = z
  .discriminatedUnion("type", [
    z
      .object({
        ...common,
        type: z.literal("EXTRACT"),
        payload: z.object({ evidence_id: uuid }).strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("REEMBED"),
        payload: z.object({ belief_version_id: uuid }).strict(),
      })
      .strict(),
    z.object({ ...common, type: z.literal("DECAY"), payload: z.object({}).strict() }).strict(),
    z
      .object({ ...common, type: z.literal("COMPILE_PROFILE"), payload: z.object({}).strict() })
      .strict(),
  ])
  .refine((i) => i.backoffBaseMs <= i.backoffCapMs, "invalid backoff policy");
const taskType = z.enum(["EXTRACT", "REEMBED", "DECAY", "COMPILE_PROFILE"]);
const Claim = z
  .object({
    projectId: uuid.optional(),
    excludeTaskIds: z
      .array(uuid)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
    types: z
      .array(taskType)
      .min(1)
      .max(4)
      .refine((a) => new Set(a).size === a.length)
      .default(["EXTRACT", "REEMBED", "DECAY", "COMPILE_PROFILE"]),
    limit: z.number().int().min(1).max(100).default(1),
    leaseMs: z.number().int().min(1).max(300000).default(30000),
  })
  .strict();
const Lease = z.object({ id: uuid, projectId: uuid, leaseToken: uuid });
const leaseDuration = z.number().int().min(1).max(300000);
const ErrorCode = z.enum(["HANDLER_FAILED", "TIMEOUT"]);
export type TaskRow = typeof memoryTasks.$inferSelect;
export type ClaimedTask = TaskRow & { leaseToken: string; leaseExpiresAt: Date };
export type TaskLease = { id: string; projectId: string; leaseToken: string };

async function checkTaskReference(
  tx: PostgresJsDatabase | Transaction,
  input: z.infer<typeof Input>,
) {
  let scoped: { id: string } | undefined;
  if (input.type === "EXTRACT") {
    [scoped] = await tx
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(messages.id, input.payload.evidence_id),
          eq(conversations.projectId, input.projectId),
        ),
      )
      .limit(1)
      .for("key share");
  } else if (input.type === "REEMBED") {
    [scoped] = await tx
      .select({ id: beliefVersions.id })
      .from(beliefVersions)
      .innerJoin(beliefs, eq(beliefVersions.beliefId, beliefs.id))
      .where(
        and(
          eq(beliefVersions.id, input.payload.belief_version_id),
          eq(beliefs.projectId, input.projectId),
        ),
      )
      .limit(1)
      .for("key share");
  } else {
    [scoped] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1)
      .for("key share");
  }
  if (!scoped) throw Error("invalid task scope");
}
/** Revalidate persisted JSON references before a worker invokes a handler. Never spread a task row. */
export async function assertTaskScope(db: PostgresJsDatabase, task: TaskRow): Promise<void> {
  const input = Input.parse({
    projectId: task.projectId,
    type: task.type,
    payload: task.payload,
    idempotencyKey: task.idempotencyKey,
    maxAttempts: task.maxAttempts,
    backoffBaseMs: task.backoffBaseMs,
    backoffCapMs: task.backoffCapMs,
    runAt: task.runAt,
  });
  await db.transaction((tx) => checkTaskReference(tx, input));
}

/** Canonical type-specific reference payloads only. Repeated identity never changes the original task. */
export async function enqueueTask(db: PostgresJsDatabase, value: unknown) {
  const input = Input.parse(value);
  return db.transaction(async (tx) => {
    await checkTaskReference(tx, input);
    const { runAt, ...persisted } = input;
    const [created] = await tx
      .insert(memoryTasks)
      .values({ ...persisted, ...(runAt ? { runAt } : {}), id: uuidv7() })
      .onConflictDoNothing({
        target: [memoryTasks.projectId, memoryTasks.type, memoryTasks.idempotencyKey],
      })
      .returning();
    if (created) return { task: created, created: true };
    const [existing] = await tx
      .select()
      .from(memoryTasks)
      .where(
        and(
          eq(memoryTasks.projectId, input.projectId),
          eq(memoryTasks.type, input.type),
          eq(memoryTasks.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (
      !existing ||
      JSON.stringify(existing.payload) !== JSON.stringify(input.payload) ||
      existing.maxAttempts !== input.maxAttempts ||
      existing.backoffBaseMs !== input.backoffBaseMs ||
      existing.backoffCapMs !== input.backoffCapMs
    )
      throw Error("task identity conflict");
    return { task: existing, created: false };
  });
}

/** Claim is internal worker plumbing, not an HTTP permission boundary. Locks skip contending workers. */
export async function claimTasks(
  db: PostgresJsDatabase,
  value: z.input<typeof Claim> = {},
): Promise<ClaimedTask[]> {
  const options = Claim.parse(value);
  const scope = and(
    options.projectId ? eq(memoryTasks.projectId, options.projectId) : undefined,
    inArray(memoryTasks.type, options.types),
    options.excludeTaskIds.length ? notInArray(memoryTasks.id, options.excludeTaskIds) : undefined,
  );
  return db.transaction(async (tx) => {
    // Bounded recovery of crashed final attempts; never silently invoke attempt max+1.
    const expired = await tx
      .select({ id: memoryTasks.id })
      .from(memoryTasks)
      .where(
        and(
          scope,
          eq(memoryTasks.status, "running"),
          sql`${memoryTasks.leaseExpiresAt} <= clock_timestamp()`,
          sql`${memoryTasks.attempts} >= ${memoryTasks.maxAttempts}`,
        ),
      )
      .orderBy(asc(memoryTasks.leaseExpiresAt), asc(memoryTasks.id))
      .limit(100)
      .for("update", { skipLocked: true });
    if (expired.length)
      await tx
        .update(memoryTasks)
        .set({
          status: "dead",
          leaseToken: null,
          leaseExpiresAt: null,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
          lastErrorCode: "LEASE_EXPIRED",
        })
        .where(
          inArray(
            memoryTasks.id,
            expired.map((r) => r.id),
          ),
        );
    const picked = await tx
      .select({ id: memoryTasks.id })
      .from(memoryTasks)
      .where(
        and(
          scope,
          sql`${memoryTasks.attempts} < ${memoryTasks.maxAttempts}`,
          sql`((${memoryTasks.status} in ('queued','failed') and ${memoryTasks.runAt} <= clock_timestamp()) or
        (${memoryTasks.status} = 'running' and ${memoryTasks.leaseExpiresAt} <= clock_timestamp()))`,
        ),
      )
      .orderBy(asc(memoryTasks.runAt), asc(memoryTasks.createdAt), asc(memoryTasks.id))
      .limit(options.limit)
      .for("update", { skipLocked: true });
    if (!picked.length) return [];
    const rows = await tx
      .update(memoryTasks)
      .set({
        status: "running",
        attempts: sql`${memoryTasks.attempts} + 1`,
        leaseToken: uuidv7(),
        leaseExpiresAt: sql`clock_timestamp() + ${options.leaseMs} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
        lastErrorCode: sql`case when ${memoryTasks.status} = 'running' then 'LEASE_EXPIRED' else ${memoryTasks.lastErrorCode} end`,
      })
      .where(
        inArray(
          memoryTasks.id,
          picked.map((r) => r.id),
        ),
      )
      .returning();
    const order = new Map(picked.map((r, i) => [r.id, i]));
    return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!) as ClaimedTask[];
  });
}
function owned(lease: TaskLease) {
  return and(
    eq(memoryTasks.id, lease.id),
    eq(memoryTasks.projectId, lease.projectId),
    eq(memoryTasks.status, "running"),
    eq(memoryTasks.leaseToken, lease.leaseToken),
    sql`${memoryTasks.leaseExpiresAt} > clock_timestamp()`,
  );
}
type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
/** UPDATE predicates may be evaluated before waiting on a pure row lock. Recheck DB time in a
 * new statement after acquiring ownership; capture identity before awaiting caller-owned objects. */
async function withOwnedLease<R>(
  db: PostgresJsDatabase,
  value: TaskLease,
  run: (tx: Transaction, lease: TaskLease) => Promise<R>,
  missing: R,
): Promise<R> {
  const lease = Lease.parse(value);
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: memoryTasks.id })
      .from(memoryTasks)
      .where(owned(lease))
      .limit(1)
      .for("update");
    return locked ? run(tx, lease) : missing;
  });
}
export async function completeTask(db: PostgresJsDatabase, lease: TaskLease): Promise<boolean> {
  const rows = await withOwnedLease(
    db,
    lease,
    async (tx, current) =>
      tx
        .update(memoryTasks)
        .set({
          status: "done",
          leaseToken: null,
          leaseExpiresAt: null,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(owned(current))
        .returning({ id: memoryTasks.id }),
    [],
  );
  return rows.length > 0;
}
export async function retryTask(
  db: PostgresJsDatabase,
  lease: TaskLease,
  error: z.infer<typeof ErrorCode>,
) {
  const code = ErrorCode.parse(error);
  const rows = await withOwnedLease(
    db,
    lease,
    async (tx, current) =>
      tx
        .update(memoryTasks)
        .set({
          status: sql`case when ${memoryTasks.attempts} >= ${memoryTasks.maxAttempts} then 'dead'::memory_task_status else 'failed'::memory_task_status end`,
          runAt: sql`clock_timestamp() + least(${memoryTasks.backoffCapMs}::numeric,
      ${memoryTasks.backoffBaseMs}::numeric * power(2::numeric, ${memoryTasks.attempts} - 1)) * interval '1 millisecond'`,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: code,
          updatedAt: sql`clock_timestamp()`,
          finishedAt: sql`case when ${memoryTasks.attempts} >= ${memoryTasks.maxAttempts} then clock_timestamp() else null end`,
        })
        .where(owned(current))
        .returning({ status: memoryTasks.status }),
    [],
  );
  return rows[0]?.status ?? null;
}
export async function renewTaskLease(
  db: PostgresJsDatabase,
  lease: TaskLease,
  leaseMs: number,
): Promise<boolean> {
  const duration = leaseDuration.parse(leaseMs);
  const rows = await withOwnedLease(
    db,
    lease,
    async (tx, current) =>
      tx
        .update(memoryTasks)
        .set({
          leaseExpiresAt: sql`greatest(${memoryTasks.leaseExpiresAt}, clock_timestamp() + ${duration} * interval '1 millisecond')`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(owned(current))
        .returning({ id: memoryTasks.id }),
    [],
  );
  return rows.length > 0;
}
export async function listDeadTasks(
  db: PostgresJsDatabase,
  value: { projectId: string; limit?: number; offset?: number },
) {
  const input = z
    .object({
      projectId: uuid,
      limit: z.number().int().min(1).max(1000).default(50),
      offset: z.number().int().nonnegative().max(2147483647).default(0),
    })
    .strict()
    .parse(value);
  return db
    .select()
    .from(memoryTasks)
    .where(and(eq(memoryTasks.projectId, input.projectId), eq(memoryTasks.status, "dead")))
    .orderBy(asc(memoryTasks.createdAt), asc(memoryTasks.id))
    .limit(input.limit)
    .offset(input.offset);
}
