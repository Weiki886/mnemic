import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { beliefs } from "../db/schema.js";
import type { CandidateWithAuthority } from "../extraction/authority.js";
import { writeAuditLog } from "./audit.js";
import { evaluateGate, type GateDecision, type GateScores } from "./gate.js";
import { createPending } from "./pending-repository.js";
import { sanitizeText } from "./secrets.js";

/**
 * Gate 处理管道（#15）：脱敏 → 审计 → 判定 → 路由。
 * WRITE 只表示"通过 Gate"，真正写 Observation / 去重分流归 #16；
 * PENDING 落 pending_candidates（已脱敏快照），TTL 默认 7 天。
 */

export const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;

export type ProcessResult =
  | { decision: "WRITE"; candidate: CandidateWithAuthority; scores: GateScores }
  | { decision: "SKIP"; scores: GateScores }
  | { decision: "PENDING"; pendingId: string; scores: GateScores };

const SANITIZE_FIELDS = ["value", "subject", "attribute"] as const;

export async function processCandidate(
  db: PostgresJsDatabase,
  projectId: string,
  input: CandidateWithAuthority,
  evidenceId: string,
): Promise<ProcessResult> {
  // 1. 脱敏：命中即替换并逐字段写审计（meta 只记模式名，绝不记密钥本体）
  const candidate = { ...input };
  for (const field of SANITIZE_FIELDS) {
    const r = sanitizeText(candidate[field]);
    if (r.hits.length > 0) {
      candidate[field] = r.text;
      for (const hit of r.hits) {
        await writeAuditLog(db, {
          actor: "gate",
          action: "redact",
          target: `candidate.${field}`,
          decision: "redacted",
          meta: { pattern: hit.pattern, count: hit.count },
        });
      }
    }
  }

  // 2. novelty 上下文：同 subject+attribute 是否已有 Belief
  const existing = await db
    .select({ id: beliefs.id })
    .from(beliefs)
    .where(
      and(
        eq(beliefs.projectId, projectId),
        eq(beliefs.subject, candidate.subject),
        eq(beliefs.attribute, candidate.attribute),
      ),
    )
    .limit(1);

  // 3. 判定
  const { decision, scores } = evaluateGate(candidate, { beliefExists: existing.length > 0 });

  // 4. 路由
  if (decision === "PENDING") {
    const row = await createPending(db, {
      projectId,
      candidate,
      gateScores: scores,
      evidenceId,
      ttlMs: PENDING_TTL_MS,
    });
    return { decision, pendingId: row.id, scores };
  }
  if (decision === "SKIP") {
    return { decision, scores };
  }
  return { decision: decision as GateDecision & "WRITE", candidate, scores };
}
