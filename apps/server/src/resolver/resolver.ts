import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { beliefVersions, beliefs, observations } from "../db/schema.js";
import { DefaultAssertIntentPolicy, type IntentPolicy } from "./intent-policy.js";
import { decideRelation } from "./policies.js";
import {
  noopTraceWriter,
  type ConflictRelation,
  type ResolutionTraceWriter,
} from "./types.js";
import { classifyValues } from "./value-compare.js";

export type ObservationRow = typeof observations.$inferSelect;
export type BeliefRow = typeof beliefs.$inferSelect;

/** Resolver 版本：写入 belief_versions.resolver_version 与 trace（算法变更需升版，否则历史不可比） */
export const RESOLVER_VERSION = "0.1.0";

// A0 启发式系数（校准归 #12 评测平台，勿分散硬编码）
export const STRENGTHEN_BOOST = 0.1;
export const WEAKEN_PENALTY = 0.2;

export interface ResolveParams {
  projectId: string;
  /** 已落库的 Observation 行（落库归 #16，本接口只消费） */
  observation: ObservationRow;
  /** 同 project+subject+attribute 的当前 Belief（调用方 #16 保证匹配） */
  belief: BeliefRow;
}

export interface ResolveResult {
  /** null = IntentPolicy 裁决 ignore，未作用于 Belief */
  relation: ConflictRelation | null;
  resultVersionId: string | null;
}

export interface ResolverDeps {
  intentPolicy?: IntentPolicy;
  traceWriter?: ResolutionTraceWriter;
  now?: () => Date;
}

/**
 * Resolver 编排（被 #16 进程内同步调用）：
 * Intent（预留接口）→ Authority/Temporal/Conflict 纯函数矩阵 → 事务落库 → trace 留痕。
 * 落库规则：
 *   strengthen/weaken（权威驳回）不建版本，仅 evidence_count/confidence 调整；
 *   weaken（迟到证据）建历史版本入链（valid_to=当前版本 valid_from），当前值不动；
 *   extend/supersede 建当前版本，旧版本双时态关闭（valid_to=新证据生效时点，recorded_to=now）。
 * 画像类 Belief 四态变更均置 profile_dirty（#41 触发链）。
 * 读取路径不在本模块：此处没有任何 SELECT 后的写回，检索侧不改 confidence/salience。
 */
export async function resolveObservation(
  db: PostgresJsDatabase,
  params: ResolveParams,
  deps: ResolverDeps = {},
): Promise<ResolveResult> {
  const intentPolicy = deps.intentPolicy ?? new DefaultAssertIntentPolicy();
  const traceWriter = deps.traceWriter ?? noopTraceWriter;
  const now = deps.now ?? (() => new Date());
  const { observation, belief, projectId } = params;

  // 1. Intent Policy（#17 替换点；默认 ASSERT 直通）
  const verdict = intentPolicy.decide({ intent: observation.assertionIntent });
  if (verdict.action === "ignore") {
    await traceWriter.write({
      projectId,
      beliefId: belief.id,
      observationId: observation.id,
      relation: null,
      policies: { intent: { action: "ignore" } },
      previousVersionId: belief.currentVersionId,
      resultVersionId: null,
      resolverVersion: RESOLVER_VERSION,
    });
    return { relation: null, resultVersionId: null };
  }

  // 2. 当前版本与其来源 Observation 的权威（权威创建即写入，非此处现算）
  const [current] = belief.currentVersionId
    ? await db
        .select()
        .from(beliefVersions)
        .where(eq(beliefVersions.id, belief.currentVersionId))
        .limit(1)
    : [undefined];
  let currentAuthority = 0;
  if (current?.sourceObservationId) {
    const [src] = await db
      .select({ authority: observations.authority })
      .from(observations)
      .where(eq(observations.id, current.sourceObservationId))
      .limit(1);
    currentAuthority = src?.authority ?? 0;
  }

  // 3. Temporal/Conflict 判定（valid_time 兜底规则见 schema 注释，#3 已固化）
  const incomingValidFrom = observation.validTime ?? observation.recordedAt;
  const outcome = decideRelation({
    incomingAuthority: observation.authority,
    currentAuthority,
    incomingValidFrom,
    currentValidFrom: current?.validFrom ?? new Date(0),
    currentValidTo: current?.validTo ?? null,
    valueRelation: current ? classifyValues(current.value, observation.value) : "conflict",
  });

  // 4. 事务落库
  const at = now();
  let resultVersionId: string | null = null;
  await db.transaction(async (tx) => {
    const markDirty = belief.isProfile ? { profileDirty: true } : {};
    const bumpEvidence = sql`${beliefs.evidenceCount} + 1`;
    const currentConfidence = Number(belief.confidence ?? 0.5);

    if (outcome.relation === "strengthen") {
      await tx
        .update(beliefs)
        .set({
          evidenceCount: bumpEvidence,
          confidence: String(Math.min(1, currentConfidence + STRENGTHEN_BOOST)),
          ...markDirty,
        })
        .where(eq(beliefs.id, belief.id));
    } else if (outcome.relation === "weaken" && outcome.detail.reason === "late_evidence" && current) {
      const id = uuidv7();
      await tx.insert(beliefVersions).values({
        id,
        beliefId: belief.id,
        value: observation.value,
        validFrom: incomingValidFrom,
        validTo: current.validFrom,
        recordedFrom: at,
        sourceObservationId: observation.id,
        resolverVersion: RESOLVER_VERSION,
        confidence: observation.confidence,
      });
      await tx
        .update(beliefs)
        .set({ evidenceCount: bumpEvidence, ...markDirty })
        .where(eq(beliefs.id, belief.id));
      resultVersionId = id;
    } else if (outcome.relation === "weaken") {
      await tx
        .update(beliefs)
        .set({
          evidenceCount: bumpEvidence,
          confidence: String(Math.max(0, currentConfidence - WEAKEN_PENALTY)),
          ...markDirty,
        })
        .where(eq(beliefs.id, belief.id));
    } else {
      // extend / supersede
      const id = uuidv7();
      await tx.insert(beliefVersions).values({
        id,
        beliefId: belief.id,
        value: observation.value,
        validFrom: incomingValidFrom,
        recordedFrom: at,
        supersedesVersionId: current?.id ?? null,
        sourceObservationId: observation.id,
        resolverVersion: RESOLVER_VERSION,
        confidence: observation.confidence,
      });
      if (current) {
        await tx
          .update(beliefVersions)
          .set({ validTo: incomingValidFrom, recordedTo: at })
          .where(eq(beliefVersions.id, current.id));
      }
      await tx
        .update(beliefs)
        .set({
          currentVersionId: id,
          evidenceCount: bumpEvidence,
          confidence: observation.confidence ?? belief.confidence,
          ...markDirty,
        })
        .where(eq(beliefs.id, belief.id));
      resultVersionId = id;
    }
  });

  // 5. trace 留痕（决策 11；落库归 #18 替换 writer）
  await traceWriter.write({
    projectId,
    beliefId: belief.id,
    observationId: observation.id,
    relation: outcome.relation,
    policies: { intent: { action: "proceed" }, detail: outcome.detail },
    previousVersionId: current?.id ?? null,
    resultVersionId,
    resolverVersion: RESOLVER_VERSION,
  });
  return { relation: outcome.relation, resultVersionId };
}
