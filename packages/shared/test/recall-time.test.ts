import { expect, it } from "vitest";
import { RecallTimePointSchema } from "../src/memory.js";
it.each([
  "0001-01-01T00:00:00Z",
  "2024-02-29T23:59:59.123456Z",
  "2026-01-01T00:00:00.1Z",
  "9999-12-31T23:59:59.999999Z",
])("preserves valid UTC query time %s verbatim", (time) => {
  expect(RecallTimePointSchema.parse(time)).toBe(time);
});
it.each([
  null,
  0,
  "",
  "sk-secret",
  "2026-02-30T00:00:00Z",
  "0000-01-01T00:00:00Z",
  "2026-01-01T00:00:00.1234567Z",
  "2026-01-01T00:00:00+00:00",
  "2026-01-01",
  "2026-01-01T24:00:00Z",
])("rejects invalid query time %#", (time) => {
  expect(RecallTimePointSchema.safeParse(time).success).toBe(false);
});
