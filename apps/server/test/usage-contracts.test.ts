import { expect, it } from "vitest";
import { UsageParamsSchema } from "../src/contracts/usage.js";
it("usage project params preserve UUID normalization and strict unknown-key rejection", () => {
  const id = "019abcde-0000-7000-8000-000000000001";
  expect(UsageParamsSchema.parse({ projectId: id.toUpperCase() })).toEqual({ projectId: id });
  for (const input of [{}, { projectId: "bad" }, { projectId: id, extra: "rejected" }])
    expect(UsageParamsSchema.safeParse(input).success).toBe(false);
});
