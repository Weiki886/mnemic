import type { ValueRelation } from "./value-compare.js";
import type { ConflictRelation } from "./types.js";

/**
 * Authority / Temporal / Conflict 三 Policy 的纯函数判定（Intent 在其之前，接口见 intent-policy.ts）。
 * 矩阵（值冲突时）：
 *   当前版本已过 valid_to → supersede（已关闭版本不参与比对）
 *   新证据权威更高 → supersede（低权威不可覆盖高权威，决策 4）
 *   新证据权威更低 → weaken（挑战被驳回，当前值不变）
 *   同权威：valid_time 新者 → supersede；更早（迟到/乱序）→ weaken + 历史版本留痕
 * 值等价 → strengthen（佐证，权威高低都成立）；新值涵盖旧值 → extend。
 */

export interface PolicyContext {
  /** 新证据权威（observations.authority：70→10，大者胜） */
  incomingAuthority: number;
  /** 当前版本来源 Observation 的权威 */
  currentAuthority: number;
  /** 新证据 valid_time（已按 validTime ?? recordedAt 兜底解析） */
  incomingValidFrom: Date;
  currentValidFrom: Date;
  /** 非 null = 当前版本已关闭，不参与比对 */
  currentValidTo: Date | null;
  valueRelation: ValueRelation;
}

export interface PolicyOutcome {
  relation: ConflictRelation;
  detail: {
    authority: { incoming: number; current: number; verdict: "higher" | "lower" | "equal" };
    temporal: {
      incomingValidFrom: string;
      currentValidFrom: string;
      late: boolean;
      currentClosed: boolean;
    };
    conflict: { valueRelation: ValueRelation };
    reason: "authority" | "temporal" | "late_evidence" | "equivalent" | "contained" | null;
  };
}

export function decideRelation(ctx: PolicyContext): PolicyOutcome {
  const authorityVerdict =
    ctx.incomingAuthority > ctx.currentAuthority
      ? "higher"
      : ctx.incomingAuthority < ctx.currentAuthority
        ? "lower"
        : "equal";
  const late = ctx.incomingValidFrom < ctx.currentValidFrom;
  const currentClosed = ctx.currentValidTo !== null;
  const detail: PolicyOutcome["detail"] = {
    authority: { incoming: ctx.incomingAuthority, current: ctx.currentAuthority, verdict: authorityVerdict },
    temporal: {
      incomingValidFrom: ctx.incomingValidFrom.toISOString(),
      currentValidFrom: ctx.currentValidFrom.toISOString(),
      late,
      currentClosed,
    },
    conflict: { valueRelation: ctx.valueRelation },
    reason: null,
  };

  if (ctx.valueRelation === "equal") {
    detail.reason = "equivalent";
    return { relation: "strengthen", detail };
  }
  if (ctx.valueRelation === "extend") {
    detail.reason = "contained";
    return { relation: "extend", detail };
  }
  // conflict
  if (currentClosed) {
    detail.reason = "temporal";
    return { relation: "supersede", detail };
  }
  if (authorityVerdict === "higher") {
    detail.reason = "authority";
    return { relation: "supersede", detail };
  }
  if (authorityVerdict === "lower") {
    detail.reason = "authority";
    return { relation: "weaken", detail };
  }
  // 同权威：valid_time 新者优先；更早为迟到/乱序证据，不改判
  if (late) {
    detail.reason = "late_evidence";
    return { relation: "weaken", detail };
  }
  detail.reason = "temporal";
  return { relation: "supersede", detail };
}
