import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { beliefVersions, beliefs, observations } from "../db/schema.js";
import type { CandidateWithAuthority } from "../extraction/authority.js";
import type { ConflictRelation } from "../resolver/types.js";
import { RESOLVER_VERSION, resolveObservation, type ResolverDeps } from "../resolver/resolver.js";
import { DbResolutionTraceWriter } from "../resolver/trace-writer.js";
import { classifyValues } from "../resolver/value-compare.js";
import { normalizeTerm } from "./normalization.js";

/** 四路分流路由（#16，Proposal 1.5：不同值绝不能被合并） */
export type IngestRoute = "created" | "merged" | "skipped" | "conflict";

export interface IngestResult {
  route: IngestRoute;
  /** skipped 时为幂等命中已存在的行 */
  observationId: string | null;
  beliefId: string | null;
  /** merged/conflict 时 Resolver 的四态输出 */
  relation: ConflictRelation | null;
}

/** valid_time 为 ISO 原文则解析，模糊原文无法解析 → null（recorded_at 兜底规则见 schema 注释） */
function parseValidTime(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 写入路径③（#16）：规范化 → Observation 落库 → 召回 → 四路分流。
 * 重复 = 同 evidence + 同规范化 subject+attribute（幂等跳过）；
 * 等价/冲突的消解动作委托 #5 Resolver（进程内同步调用，A1 #21 队列化后再评估异步）。
 */
export async function ingestCandidate(
  db: PostgresJsDatabase,
  projectId: string,
  candidate: CandidateWithAuthority,
  evidenceId: string,
  deps: ResolverDeps = {},
): Promise<IngestResult> {
  const subject = normalizeTerm(candidate.subject);
  const attribute = normalizeTerm(candidate.attribute);

  // 1. 幂等去重（重复投递）
  const [dup] = await db
    .select({ id: observations.id })
    .from(observations)
    .where(
      and(
        eq(observations.projectId, projectId),
        eq(observations.evidenceId, evidenceId),
        eq(observations.subject, subject),
        eq(observations.attribute, attribute),
      ),
    )
    .limit(1);
  if (dup) {
    return { route: "skipped", observationId: dup.id, beliefId: null, relation: null };
  }

  // 2. Observation 落库（规范化后的 subject/attribute，权威随候选写入）
  const [obs] = await db
    .insert(observations)
    .values({
      id: uuidv7(),
      projectId,
      type: candidate.type,
      subject,
      attribute,
      value: candidate.value,
      assertionIntent: candidate.assertion_intent,
      sourceType: candidate.source_type,
      authority: candidate.authority,
      reliability: String(candidate.reliability),
      validTime: parseValidTime(candidate.valid_time),
      timePrecision: candidate.time_precision,
      timeConfidence: String(candidate.time_confidence),
      evidenceId,
      importance: String(candidate.importance),
      confidence: String(candidate.confidence),
      entities: candidate.entities,
      isProfile: candidate.is_profile,
    })
    .returning();

  // 3. 召回同 subject+attribute 的 Belief
  const [belief] = await db
    .select()
    .from(beliefs)
    .where(
      and(
        eq(beliefs.projectId, projectId),
        eq(beliefs.subject, subject),
        eq(beliefs.attribute, attribute),
      ),
    )
    .limit(1);

  // 4a. 无关 → 创建（Belief + 首版本，画像类置 profile_dirty；salience 初始 = importance，#10 衰减起点）
  if (!belief) {
    const beliefId = uuidv7();
    const versionId = uuidv7();
    await db.transaction(async (tx) => {
      await tx.insert(beliefs).values({
        id: beliefId,
        projectId,
        subject,
        attribute,
        confidence: String(candidate.confidence),
        salience: String(candidate.importance),
        importance: String(candidate.importance),
        isProfile: candidate.is_profile,
        profileDirty: candidate.is_profile,
      });
      await tx.insert(beliefVersions).values({
        id: versionId,
        beliefId,
        value: candidate.value,
        validFrom: obs!.validTime ?? obs!.recordedAt,
        recordedFrom: new Date(),
        sourceObservationId: obs!.id,
        resolverVersion: RESOLVER_VERSION,
        confidence: String(candidate.confidence),
      });
      await tx.update(beliefs).set({ currentVersionId: versionId }).where(eq(beliefs.id, beliefId));
    });
    return { route: "created", observationId: obs!.id, beliefId, relation: null };
  }

  // 4b. 等价（merged）/ 不同值（conflict）→ 委托 #5 Resolver
  const [current] = belief.currentVersionId
    ? await db.select().from(beliefVersions).where(eq(beliefVersions.id, belief.currentVersionId)).limit(1)
    : [undefined];
  const valueRelation = current ? classifyValues(current.value, obs!.value) : "conflict";
  // trace 落库接线（#18）：调用方未指定 writer 时默认落 resolution_traces
  const resolved = await resolveObservation(db, { projectId, observation: obs!, belief }, {
    ...deps,
    traceWriter: deps.traceWriter ?? new DbResolutionTraceWriter(db),
  });
  return {
    route: valueRelation === "equal" ? "merged" : "conflict",
    observationId: obs!.id,
    beliefId: belief.id,
    relation: resolved.relation,
  };
}
