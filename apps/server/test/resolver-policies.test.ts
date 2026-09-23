import { describe, expect, it } from "vitest";
import { decideRelation, type PolicyContext } from "../src/resolver/policies.js";

const T1 = new Date("2026-09-01T00:00:00Z");
const T2 = new Date("2026-09-10T00:00:00Z");

const base: PolicyContext = {
  incomingAuthority: 60, // USER_EXPLICIT
  currentAuthority: 60,
  incomingValidFrom: T2,
  currentValidFrom: T1,
  currentValidTo: null,
  valueRelation: "conflict",
};

describe("Resolver 三 Policy 判定矩阵（#5）", () => {
  it("值等价 → strengthen（权威高低都成立，佐证就是佐证）", () => {
    expect(decideRelation({ ...base, valueRelation: "equal" }).relation).toBe("strengthen");
    expect(
      decideRelation({ ...base, valueRelation: "equal", incomingAuthority: 10 }).relation,
    ).toBe("strengthen");
  });

  it("新值涵盖旧值 → extend", () => {
    const out = decideRelation({ ...base, valueRelation: "extend" });
    expect(out.relation).toBe("extend");
    expect(out.detail.reason).toBe("contained");
  });

  it("冲突 + 新证据权威更高 → supersede（用户明确说换 PostgreSQL 胜过 Agent 推测 MySQL）", () => {
    const out = decideRelation({ ...base, incomingAuthority: 60, currentAuthority: 10 });
    expect(out.relation).toBe("supersede");
    expect(out.detail.reason).toBe("authority");
    expect(out.detail.authority.verdict).toBe("higher");
  });

  it("冲突 + 新证据权威更低 → weaken（低权威不可覆盖高权威）", () => {
    const out = decideRelation({ ...base, incomingAuthority: 10, currentAuthority: 60 });
    expect(out.relation).toBe("weaken");
    expect(out.detail.reason).toBe("authority");
    expect(out.detail.authority.verdict).toBe("lower");
  });

  it("冲突 + 同权威 + 新 valid_time → supersede（新者优先）", () => {
    const out = decideRelation({ ...base, incomingValidFrom: T2, currentValidFrom: T1 });
    expect(out.relation).toBe("supersede");
    expect(out.detail.reason).toBe("temporal");
  });

  it("冲突 + 同权威 + 更早 valid_time（迟到证据）→ weaken + late 标记（不改判，历史留痕）", () => {
    const out = decideRelation({ ...base, incomingValidFrom: T1, currentValidFrom: T2 });
    expect(out.relation).toBe("weaken");
    expect(out.detail.reason).toBe("late_evidence");
    expect(out.detail.temporal.late).toBe(true);
  });

  it("当前版本已过 valid_to → supersede（已关闭版本不参与比对）", () => {
    const out = decideRelation({ ...base, currentValidTo: T2 });
    expect(out.relation).toBe("supersede");
    expect(out.detail.temporal.currentClosed).toBe(true);
  });
});
