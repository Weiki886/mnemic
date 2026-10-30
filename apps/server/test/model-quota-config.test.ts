import { expect, it } from "vitest";
import { resolveModelDailyCallLimit } from "../src/config.js";
it("defaults to 1000 calls and rejects empty, zero, fractional and unbounded operator values safely", () => {
  expect(resolveModelDailyCallLimit(undefined)).toBe(1000);
  expect(resolveModelDailyCallLimit("25")).toBe(25);
  for (const raw of ["", "0", "-1", "1.5", "1e3", "Infinity", "1000001", "sk-sensitive"]) {
    expect(() => resolveModelDailyCallLimit(raw)).toThrow(
      "MNEMIC_MODEL_DAILY_CALL_LIMIT must be an integer from 1 to 1000000",
    );
    try {
      resolveModelDailyCallLimit(raw);
    } catch (e) {
      expect(String(e)).not.toContain("sk-sensitive");
    }
  }
});
