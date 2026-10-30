import { expect, it } from "vitest";
import { ErrorCode, PROBLEM_TYPES, ProblemDetailsSchema, problem } from "../src/errors.js";
it.each(Object.values(ErrorCode))(
  "%s emits its registered URI while keeping code/status stable",
  (code) => {
    const body = problem({ status: 400, code });
    expect(body.type).toBe(`https://mnemic.dev/errors/${code.toLowerCase().replaceAll("_", "-")}`);
    expect(ProblemDetailsSchema.parse(body)).toEqual(body);
  },
);
it("problem identifiers are unique and every supported code has exactly one URI", () => {
  expect(Object.keys(PROBLEM_TYPES).sort()).toEqual(Object.values(ErrorCode).sort());
  expect(new Set(Object.values(PROBLEM_TYPES)).size).toBe(Object.values(ErrorCode).length);
});
it("legacy about:blank remains readable, without weakening code/URI pairing", () => {
  const old = { type: "about:blank", title: "Not Found", status: 404, code: "NOT_FOUND" };
  expect(ProblemDetailsSchema.parse(old)).toEqual(old);
  expect(
    ProblemDetailsSchema.safeParse({ ...old, type: "https://mnemic.dev/errors/conflict" }).success,
  ).toBe(false);
  expect(
    ProblemDetailsSchema.safeParse({ ...old, type: "https://evil.invalid/errors/not-found" })
      .success,
  ).toBe(false);
  expect(ProblemDetailsSchema.safeParse({ ...old, code: "FUTURE_UNKNOWN" }).success).toBe(false);
});
it("strict problem fields preserve root-path errors and omit absent optional fields", () => {
  const body = problem({
    status: 400,
    code: ErrorCode.VALIDATION_FAILED,
    errors: [{ path: "", message: "invalid root" }],
  });
  expect(ProblemDetailsSchema.parse(body)).toEqual(body);
  expect(body).not.toHaveProperty("detail");
  expect(body).not.toHaveProperty("requestId");
  for (const extra of [
    { unexpected: "private" },
    { errors: [{ path: "x", message: "x", secret: "private" }] },
    { status: 200 },
    { status: 400.5 },
  ])
    expect(ProblemDetailsSchema.safeParse({ ...body, ...extra }).success).toBe(false);
});
