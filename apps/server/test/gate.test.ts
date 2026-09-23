import { describe, expect, it } from "vitest";
import { evaluateGate } from "../src/gate/gate.js";
import type { CandidateWithAuthority } from "../src/extraction/authority.js";

const base: CandidateWithAuthority = {
  type: "decision",
  subject: "my-project",
  attribute: "database",
  value: "SQLite",
  valid_time: "2026-09-01",
  time_precision: "DAY",
  time_confidence: 0.95,
  assertion_intent: "UPDATE",
  source_type: "USER_EXPLICIT",
  importance: 0.9,
  confidence: 0.9,
  entities: ["my-project", "SQLite"],
  is_profile: true,
  authority: 60,
  reliability: 0.95,
};

describe("Memory Gate 判定（#15）", () => {
  it("高价值高置信 → WRITE", () => {
    const r = evaluateGate(base, { beliefExists: false });
    expect(r.decision).toBe("WRITE");
    expect(r.scores.novelty).toBe(1);
  });

  it("「这个方案还行」类低价值客套 → SKIP（importance 低 + specificity 低）", () => {
    const r = evaluateGate(
      { ...base, type: "fact", value: "还行", importance: 0.2, is_profile: false },
      { beliefExists: false },
    );
    expect(r.decision).toBe("SKIP");
  });

  it("置信过低 → SKIP", () => {
    const r = evaluateGate({ ...base, confidence: 0.2 }, { beliefExists: false });
    expect(r.decision).toBe("SKIP");
  });

  it("重要但不确定（confidence 中档）→ PENDING", () => {
    const r = evaluateGate({ ...base, confidence: 0.5 }, { beliefExists: false });
    expect(r.decision).toBe("PENDING");
  });

  it("重要但表述模糊（specificity 低）→ PENDING", () => {
    const r = evaluateGate({ ...base, value: "还行" }, { beliefExists: false });
    expect(r.decision).toBe("PENDING");
  });

  it("同 subject+attribute 已有 Belief → novelty 降档", () => {
    const r = evaluateGate(base, { beliefExists: true });
    expect(r.scores.novelty).toBe(0.5);
  });

  it("五因子齐备且 futureUtility 随类型映射", () => {
    const r = evaluateGate(base, { beliefExists: false });
    expect(Object.keys(r.scores).sort()).toEqual(
      ["confidence", "futureUtility", "importance", "novelty", "specificity"].sort(),
    );
    expect(r.scores.futureUtility).toBe(0.8); // decision
    const f = evaluateGate({ ...base, type: "fact" }, { beliefExists: false });
    expect(f.scores.futureUtility).toBe(0.5);
  });
});
