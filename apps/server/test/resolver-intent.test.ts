import { describe, expect, it } from "vitest";
import { AssertionIntentPolicy, DefaultAssertIntentPolicy } from "../src/resolver/intent-policy.js";

describe("DefaultAssertIntentPolicy（#22 消融对照，非 Resolver 默认）", () => {
  it("ASSERT 直通：任何意图都放行给后续 Policy", () => {
    const policy = new DefaultAssertIntentPolicy();
    for (const intent of ["ASSERT", "UPDATE", "CORRECT", "RETRACT"]) {
      expect(policy.decide({ intent, valueRelation: "conflict", sourceType: "USER_EXPLICIT" })).toEqual({ action: "proceed" });
    }
  });
});

describe("AssertionIntentPolicy（#17 人工修正保护，决策 7）", () => {
  const policy = new AssertionIntentPolicy();

  it("ASSERT + 值冲突 → ignore（普通提及旧值不构成改判）", () => {
    expect(policy.decide({ intent: "ASSERT", valueRelation: "conflict", sourceType: "USER_EXPLICIT" }))
      .toEqual({ action: "ignore" });
  });

  it("ASSERT + 值等价/扩展 → proceed（佐证与补充照常）", () => {
    expect(policy.decide({ intent: "ASSERT", valueRelation: "equal", sourceType: "AGENT_INFERENCE" }))
      .toEqual({ action: "proceed" });
    expect(policy.decide({ intent: "ASSERT", valueRelation: "extend", sourceType: "USER_EXPLICIT" }))
      .toEqual({ action: "proceed" });
  });

  it("UPDATE / CORRECT + 值冲突 → proceed（交给权威矩阵）", () => {
    expect(policy.decide({ intent: "UPDATE", valueRelation: "conflict", sourceType: "USER_EXPLICIT" }))
      .toEqual({ action: "proceed" });
    expect(policy.decide({ intent: "CORRECT", valueRelation: "conflict", sourceType: "USER_CORRECTION" }))
      .toEqual({ action: "proceed" });
  });

  it("RETRACT + 用户系来源 → retract", () => {
    for (const sourceType of ["USER_CORRECTION", "USER_EXPLICIT"]) {
      expect(policy.decide({ intent: "RETRACT", valueRelation: "equal", sourceType }))
        .toEqual({ action: "retract" });
    }
  });

  it("RETRACT + 非用户系来源 → ignore（Agent 不可单方面撤回用户信念）", () => {
    expect(policy.decide({ intent: "RETRACT", valueRelation: "equal", sourceType: "AGENT_INFERENCE" }))
      .toEqual({ action: "ignore" });
    expect(policy.decide({ intent: "RETRACT", valueRelation: "equal", sourceType: "TOOL_OBSERVATION" }))
      .toEqual({ action: "ignore" });
  });
});
