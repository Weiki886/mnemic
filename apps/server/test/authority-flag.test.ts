import { expect, it } from "vitest";
import { decideRelation } from "../src/resolver/policies.js";
const base = {
  incomingAuthority: 10,
  currentAuthority: 70,
  incomingValidFrom: new Date("2026-10-20"),
  currentValidFrom: new Date("2026-10-01"),
  currentValidTo: null,
  valueRelation: "conflict" as const,
};
it("authority off lets temporal policy choose newer lower-authority evidence", () => {
  expect(decideRelation(base).relation).toBe("weaken");
  expect(decideRelation({ ...base, authorityEnabled: false }).relation).toBe("supersede");
});
it("authority off rejects a late higher-authority conflict by time rather than authority", () => {
  const input = {
    ...base,
    incomingAuthority: 70,
    currentAuthority: 10,
    incomingValidFrom: new Date("2026-09-01"),
  };
  expect(decideRelation(input).relation).toBe("supersede");
  expect(decideRelation({ ...input, authorityEnabled: false })).toMatchObject({
    relation: "weaken",
    detail: { reason: "late_evidence" },
  });
});
