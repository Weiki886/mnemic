import type { beliefVersions, observations } from "../db/schema.js";
import type { ValueRelation } from "./value-compare.js";

export type ObservationRow = typeof observations.$inferSelect;
export type BeliefVersionRow = typeof beliefVersions.$inferSelect;

/** 四态关系（Conflict Policy 输出，Proposal 决策 5） */
export type ConflictRelation = "strengthen" | "weaken" | "extend" | "supersede";

/**
 * Intent Policy 裁决：
 * proceed 继续后续 Policy；ignore 本证据不作用于 Belief；
 * retract 信念失效留痕（#17，RETRACT → status='retracted'，不物理删除）。
 */
export type IntentVerdict = { action: "proceed" } | { action: "ignore" } | { action: "retract" };

/** Intent Policy 裁决输入（值关系是无立场的事实计算，在 Intent 评估之前完成） */
export interface IntentInput {
  intent: string;
  valueRelation: ValueRelation;
  sourceType: string;
}

/**
 * 消解轨迹记录（决策 11：更新链路与检索链路对等可观测）。
 * 接口由 #5 定义；#18 自带 resolution_traces 迁移后落库替换 no-op 实现（一表一主）。
 */
export interface ResolutionTraceRecord {
  projectId: string;
  beliefId: string;
  observationId: string;
  relation: ConflictRelation | null;
  /** 各 Policy 决策数据（权威比较、时序判定、前后置信），只存决策数据不复制正文 */
  policies: Record<string, unknown>;
  previousVersionId: string | null;
  resultVersionId: string | null;
  resolverVersion: string;
}

export interface ResolutionTraceWriter {
  write(record: ResolutionTraceRecord): Promise<void>;
}

export const noopTraceWriter: ResolutionTraceWriter = {
  async write() {},
};
