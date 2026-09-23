import { describe, expect, it } from "vitest";
import { attachAuthority, AUTHORITY_TABLE } from "../src/extraction/authority.js";
import { CandidateSchema } from "../src/extraction/schema.js";

const validCandidate = {
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
  confidence: 0.88,
  entities: ["my-project", "SQLite"],
  is_profile: true,
};

describe("候选 Observation Schema（#4）", () => {
  it("合法候选通过校验（含 assertion_intent）", () => {
    const r = CandidateSchema.safeParse(validCandidate);
    expect(r.success).toBe(true);
  });

  it("缺 assertion_intent 拒收", () => {
    const { assertion_intent: _drop, ...rest } = validCandidate;
    expect(CandidateSchema.safeParse(rest).success).toBe(false);
  });

  it("非法枚举值拒收（type / intent / source_type / time_precision）", () => {
    expect(CandidateSchema.safeParse({ ...validCandidate, type: "memory" }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...validCandidate, assertion_intent: "ADD" }).success).toBe(
      false,
    );
    expect(
      CandidateSchema.safeParse({ ...validCandidate, source_type: "GUESS" }).success,
    ).toBe(false);
    expect(
      CandidateSchema.safeParse({ ...validCandidate, time_precision: "HOUR" }).success,
    ).toBe(false);
  });

  it("评分类字段越界拒收（0~1）", () => {
    expect(CandidateSchema.safeParse({ ...validCandidate, importance: 1.5 }).success).toBe(false);
    expect(
      CandidateSchema.safeParse({ ...validCandidate, time_confidence: -0.1 }).success,
    ).toBe(false);
  });
});

describe("权威元数据挂载（决策 4：创建即写入）", () => {
  it("七级 source_type 全部有映射，数值与排序符合决策 4", () => {
    const expected: Record<string, number> = {
      USER_CORRECTION: 70,
      USER_EXPLICIT: 60,
      PROJECT_FILE: 50,
      TOOL_OBSERVATION: 40,
      DOCUMENT: 30,
      WEB_CONTENT: 20,
      AGENT_INFERENCE: 10,
    };
    for (const [st, auth] of Object.entries(expected)) {
      const entry = AUTHORITY_TABLE[st as keyof typeof AUTHORITY_TABLE];
      expect(entry.authority).toBe(auth);
      expect(entry.reliability).toBeGreaterThan(0);
      expect(entry.reliability).toBeLessThanOrEqual(1);
    }
  });

  it("attachAuthority：随候选携带 authority/reliability", () => {
    const c = attachAuthority(CandidateSchema.parse(validCandidate));
    expect(c.authority).toBe(60);
    expect(c.reliability).toBeCloseTo(0.95);
  });
});
