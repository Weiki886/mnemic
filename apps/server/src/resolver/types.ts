import type { beliefVersions, observations } from "../db/schema.js";

export type ObservationRow = typeof observations.$inferSelect;
export type BeliefVersionRow = typeof beliefVersions.$inferSelect;

/** 四态关系（Conflict Policy 输出，Proposal 决策 5） */
export type ConflictRelation = "strengthen" | "weaken" | "extend" | "supersede";

/** Intent Policy 裁决：proceed 继续后续 Policy；ignore 本证据不作用于 Belief（#17 扩展具体策略） */
export type IntentVerdict = { action: "proceed" } | { action: "ignore" };

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
