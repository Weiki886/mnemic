import { expect, it } from "vitest";
import {
  DoctorInputSchema,
  RecallParamsSchema,
  ReadDoctorReportSchema,
  ProbeDoctorReportSchema,
} from "../src/contracts/diagnostics.js";
it("doctor requires an explicit empty object and rejects arbitrary controls", () => {
  expect(DoctorInputSchema.parse({})).toEqual({});
  expect(DoctorInputSchema.safeParse(undefined).success).toBe(false);
  expect(DoctorInputSchema.safeParse({ probe: true }).success).toBe(false);
});
it("recall path preserves UUID validation", () => {
  expect(RecallParamsSchema.safeParse({ projectId: "bad" }).success).toBe(false);
  expect(
    RecallParamsSchema.parse({ projectId: "01900000-0000-7000-8000-000000000024", extra: true }),
  ).not.toHaveProperty("extra");
});
it.each([false, true])(
  "diagnostic output probe=%s is operation-specific and failure remains a report",
  (probe) => {
    const body = {
      ok: false,
      probe,
      configSource: "server",
      checks: [{ name: "database", status: "error", detail: "unavailable" }],
    };
    expect((probe ? ProbeDoctorReportSchema : ReadDoctorReportSchema).safeParse(body).success).toBe(
      true,
    );
    expect((probe ? ReadDoctorReportSchema : ProbeDoctorReportSchema).safeParse(body).success).toBe(
      false,
    );
  },
);
