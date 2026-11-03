import { expect, it } from "vitest";
import { ApprovalParamsSchema } from "../src/contracts/approval.js";
it("approval scope parameters preserve lowercase UUID and strict object semantics", () => {
  const id = "019abcde-0000-7000-8000-000000000001";
  expect(ApprovalParamsSchema.parse({ projectId: id.toUpperCase() })).toEqual({ projectId: id });
  for (const value of [{}, { projectId: "bad" }, { projectId: id, extra: "rejected" }])
    expect(ApprovalParamsSchema.safeParse(value).success).toBe(false);
});
