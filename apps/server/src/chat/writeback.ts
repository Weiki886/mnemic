import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { extractCandidates } from "../extraction/extractor.js";
import { processCandidate } from "../gate/pipeline.js";
import { ingestCandidate, type IngestRoute } from "../ingest/ingest.js";
import { resolveModel, type ResolveOptions } from "../providers/slots.js";
import { indexBeliefVersion } from "../retrieval/embed.js";

export interface WritebackArgs {
  projectId: string;
  /** 待提取文本（单条消息或会话全量转写） */
  text: string;
  /** Provenance 锚点：候选 Observation 的 evidence_id（消息 ID） */
  evidenceId: string;
}

export interface WritebackResult {
  extracted: number;
  /** 按四路分流统计 */
  routes: Record<IngestRoute, number>;
  /** Gate 判 PENDING 的数量（已落 pending_candidates） */
  pending: number;
  /** Gate 判 SKIP 的数量 */
  skipped: number;
  degraded: boolean;
}

/**
 * 提取认领（#7，决策 6）：原子置 extracted_at，返回 true 表示认领成功。
 * 同一句话绝不重复提取——单条路径与 commit 批提取都先认领再提取，竞态下只有一方成功。
 * 认领后提取失败仅落日志（重试归 A1 #21 队列），消息不会再次被提取。
 */
export async function claimMessageForExtraction(
  db: PostgresJsDatabase,
  messageId: string,
): Promise<boolean> {
  const rows = await db.execute(
    sql`update messages set extracted_at = now() where id = ${messageId} and extracted_at is null returning id`,
  );
  return rows.length > 0;
}

/**
 * 完整写入路径复用（#7 → #4→#15→#16）：提取 → Gate（脱敏/判定）→ 去重分流 → Resolver，
 * 新版本经 #6 钩子索引 embedding。提取降级或模型未配置时静默降级（返回 degraded），
 * 绝不让后台写记忆失败影响对话主链路。
 */
export async function runExtractionWriteback(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  args: WritebackArgs,
  options: ResolveOptions = {},
): Promise<WritebackResult> {
  const empty: WritebackResult = {
    extracted: 0,
    routes: { created: 0, merged: 0, skipped: 0, conflict: 0 },
    pending: 0,
    skipped: 0,
    degraded: true,
  };

  const { model } = await resolveModel(db, masterKey, "extraction", options);
  const extraction = await extractCandidates(model, args.text);
  if (extraction.degraded) return empty;

  const result: WritebackResult = { ...empty, extracted: extraction.candidates.length, degraded: false };
  for (const candidate of extraction.candidates) {
    const gate = await processCandidate(db, args.projectId, candidate, args.evidenceId);
    if (gate.decision === "SKIP") {
      result.skipped += 1;
      continue;
    }
    if (gate.decision === "PENDING") {
      result.pending += 1;
      continue;
    }
    const ingested = await ingestCandidate(db, args.projectId, gate.candidate, args.evidenceId, {
      indexEmbedding: (a) => indexBeliefVersion(db, masterKey, a, options),
    });
    result.routes[ingested.route] += 1;
  }
  return result;
}
