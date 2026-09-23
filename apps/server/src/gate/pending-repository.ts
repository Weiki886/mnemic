import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { pendingCandidates } from "../db/schema.js";

/** PENDING 候选仓储（#15）：持久化保证重启不丢 */

export type PendingStatus = "pending" | "confirmed" | "expired" | "rejected" | "promoted";

export interface PendingRow {
  id: string;
  projectId: string;
  candidate: unknown;
  gateScores: unknown;
  status: PendingStatus;
  ttlExpiresAt: Date;
  evidenceId: string;
  createdAt: Date;
  decidedAt: Date | null;
}

type Db = PostgresJsDatabase;

function toRow(r: typeof pendingCandidates.$inferSelect): PendingRow {
  return { ...r, status: r.status as PendingStatus };
}

export async function createPending(
  db: Db,
  input: {
    projectId: string;
    candidate: unknown;
    gateScores: unknown;
    evidenceId: string;
    ttlMs: number;
  },
): Promise<PendingRow> {
  const rows = await db
    .insert(pendingCandidates)
    .values({
      id: uuidv7(),
      projectId: input.projectId,
      candidate: input.candidate,
      gateScores: input.gateScores,
      evidenceId: input.evidenceId,
      ttlExpiresAt: new Date(Date.now() + input.ttlMs),
    })
    .returning();
  return toRow(rows[0]!);
}

/** 默认只列 pending 态（待确认列表），按项目过滤 */
export async function listPending(
  db: Db,
  projectId: string,
  status: PendingStatus = "pending",
): Promise<PendingRow[]> {
  const rows = await db
    .select()
    .from(pendingCandidates)
    .where(and(eq(pendingCandidates.projectId, projectId), eq(pendingCandidates.status, status)))
    .orderBy(asc(pendingCandidates.createdAt));
  return rows.map(toRow);
}

export async function updatePendingStatus(
  db: Db,
  id: string,
  status: PendingStatus,
): Promise<PendingRow> {
  const rows = await db
    .update(pendingCandidates)
    .set({ status, decidedAt: new Date() })
    .where(eq(pendingCandidates.id, id))
    .returning();
  if (!rows[0]) throw new Error(`PENDING 候选不存在：${id}`);
  return toRow(rows[0]);
}
