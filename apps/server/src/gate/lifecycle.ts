import { and, eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { pendingCandidates } from "../db/schema.js";
import type { CandidateWithAuthority } from "../extraction/authority.js";
import { evaluateGate } from "./gate.js";
import { updatePendingStatus, type PendingRow } from "./pending-repository.js";

/**
 * PENDING 生命周期（#15）。
 * retry：同 subject+attribute 新 Observation 创建时触发重估——新证据构成佐证，
 * 置信提升 CORROBORATION_BOOST（A0 启发式 0.2，上限 1）后重过 Gate，
 * 达 WRITE 即 promoted（写入正式记忆归 #16 消费）。
 * expire：TTL 过期批量转 expired。
 */

export const CORROBORATION_BOOST = 0.2;

export async function retryPendingGroup(
  db: PostgresJsDatabase,
  projectId: string,
  subject: string,
  attribute: string,
): Promise<PendingRow[]> {
  const rows = await db
    .select()
    .from(pendingCandidates)
    .where(
      and(
        eq(pendingCandidates.projectId, projectId),
        eq(pendingCandidates.status, "pending"),
      ),
    );
  const promoted: PendingRow[] = [];
  for (const row of rows) {
    const candidate = row.candidate as CandidateWithAuthority;
    if (candidate.subject !== subject || candidate.attribute !== attribute) continue;
    const boosted = {
      ...candidate,
      confidence: Math.min(1, candidate.confidence + CORROBORATION_BOOST),
    };
    const { decision } = evaluateGate(boosted, { beliefExists: true });
    if (decision === "WRITE") {
      promoted.push(await updatePendingStatus(db, row.id, "promoted"));
    }
  }
  return promoted;
}

export async function expirePending(
  db: PostgresJsDatabase,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .update(pendingCandidates)
    .set({ status: "expired", decidedAt: now })
    .where(and(eq(pendingCandidates.status, "pending"), lt(pendingCandidates.ttlExpiresAt, now)))
    .returning({ id: pendingCandidates.id });
  return rows.map((r) => r.id);
}
