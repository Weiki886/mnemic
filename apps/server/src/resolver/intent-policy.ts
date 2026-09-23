import type { IntentInput, IntentVerdict } from "./types.js";

/** Intent Policy 接口（#5 预留插入点；#17 落地具体策略并替换默认实现，接入位置在 Authority/Temporal 之前） */
export interface IntentPolicy {
  decide(input: IntentInput): IntentVerdict;
}

/**
 * ASSERT 直通：不做意图门控，全部放行给 Authority/Temporal/Conflict。
 * 保留作 #22 消融实验"关 Intent Policy"的对照实现，不再是 Resolver 默认。
 */
export class DefaultAssertIntentPolicy implements IntentPolicy {
  decide(_input: IntentInput): IntentVerdict {
    return { action: "proceed" };
  }
}

/** 用户系来源（决策 7：仅用户证据的 UPDATE/CORRECT/RETRACT 可改变高权威信念） */
const USER_SOURCES = new Set(["USER_CORRECTION", "USER_EXPLICIT"]);

/**
 * 人工修正保护（#17，Proposal 决策 7）：
 * - ASSERT + 值冲突 → ignore（"MySQL 那个配置……"是普通提及，不构成改判）
 * - ASSERT + 值等价/扩展 → proceed（佐证/补充照常走矩阵）
 * - UPDATE / CORRECT → proceed（权威矩阵裁决）
 * - RETRACT + 用户系来源 → retract（信念失效留痕）；非用户系 → ignore（Agent 不可单方面撤回）
 */
export class AssertionIntentPolicy implements IntentPolicy {
  decide(input: IntentInput): IntentVerdict {
    if (input.intent === "RETRACT") {
      return USER_SOURCES.has(input.sourceType) ? { action: "retract" } : { action: "ignore" };
    }
    if (input.intent === "ASSERT" && input.valueRelation === "conflict") {
      return { action: "ignore" };
    }
    return { action: "proceed" };
  }
}
