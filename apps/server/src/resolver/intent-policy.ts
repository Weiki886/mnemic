import type { IntentVerdict } from "./types.js";

/** Intent Policy 接口（#5 预留插入点；#17 落地 ASSERT/UPDATE/CORRECT/RETRACT 具体策略并替换默认实现） */
export interface IntentPolicy {
  decide(input: { intent: string }): IntentVerdict;
}

/** 默认 ASSERT 直通（A0）：不做意图门控，全部放行给 Authority/Temporal/Conflict */
export class DefaultAssertIntentPolicy implements IntentPolicy {
  decide(): IntentVerdict {
    return { action: "proceed" };
  }
}
