import { describe, expect, it } from "vitest";
import { DefaultAssertIntentPolicy } from "../src/resolver/intent-policy.js";

describe("IntentPolicy 默认实现（#5 插入点预留）", () => {
  it("ASSERT 直通：任何意图都放行给后续 Policy", () => {
    const policy = new DefaultAssertIntentPolicy();
    for (const intent of ["ASSERT", "UPDATE", "CORRECT", "RETRACT"]) {
      expect(policy.decide({ intent })).toEqual({ action: "proceed" });
    }
  });
});
