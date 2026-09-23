import type { CandidateWithAuthority } from "../extraction/authority.js";

/**
 * Memory Gate（#15，决策 3：提取 ≠ 入库）。
 * 五因子：importance/confidence 取自候选（模型评估）；novelty 看同 subject+attribute
 * 是否已有 Belief；futureUtility 按类型映射；specificity 按表述具体度启发式。
 * 判定规则（A0 初始阈值，集中在此便于调整；阈值自学习是非目标）：
 *   confidence < 0.3                          → SKIP（质量太低）
 *   importance < 0.4 且 specificity < 0.5     → SKIP（低价值客套，如"这个方案还行"）
 *   confidence < 0.6 或 specificity < 0.5     → PENDING（重要但不确定/模糊，待确认）
 *   其余                                       → WRITE
 */

export interface GateScores {
  importance: number;
  novelty: number;
  futureUtility: number;
  specificity: number;
  confidence: number;
}

export type GateDecision = "WRITE" | "SKIP" | "PENDING";

export interface GateResult {
  decision: GateDecision;
  scores: GateScores;
}

const FUTURE_UTILITY_BY_TYPE: Record<CandidateWithAuthority["type"], number> = {
  decision: 0.8,
  progress: 0.7,
  preference: 0.6,
  fact: 0.5,
};

/** 空泛客套用语（ specificity 低分直判） */
const GENERIC_PHRASES = ["还行", "可以", "不错", "挺好", "随便", "再看看", "差不多"];

function computeSpecificity(candidate: CandidateWithAuthority): number {
  if (GENERIC_PHRASES.some((p) => candidate.value.includes(p))) return 0.2;
  if (candidate.entities.length > 0 && candidate.value.length >= 4) return 0.8;
  if (candidate.value.length >= 4) return 0.6;
  return 0.4;
}

export function evaluateGate(
  candidate: CandidateWithAuthority,
  context: { beliefExists: boolean },
): GateResult {
  const scores: GateScores = {
    importance: candidate.importance,
    novelty: context.beliefExists ? 0.5 : 1,
    futureUtility: FUTURE_UTILITY_BY_TYPE[candidate.type],
    specificity: computeSpecificity(candidate),
    confidence: candidate.confidence,
  };

  let decision: GateDecision;
  if (scores.confidence < 0.3) {
    decision = "SKIP";
  } else if (scores.importance < 0.4 && scores.specificity < 0.5) {
    decision = "SKIP";
  } else if (scores.confidence < 0.6 || scores.specificity < 0.5) {
    decision = "PENDING";
  } else {
    decision = "WRITE";
  }
  return { decision, scores };
}
