import { expect, it } from "vitest";
import { recoveryConnections, plainRecoveryTestUrl } from "./fixtures/recovery-connection.js";
const base = "postgres://test:offline@localhost:5432/mnemic_test";
const name = "mnemic_recovery_" + "a".repeat(32);
it.each([
  "?database=mnemic",
  "?options=-c%20search_path%3Dpublic",
  "?hostaddr=192.0.2.1",
  "#database=mnemic",
])("rejects startup override %s before a caller can open any connection", (suffix) => {
  expect(() =>
    recoveryConnections(base, "postgres://admin:offline@localhost:5432/mnemic_test" + suffix, name),
  ).toThrow("RECOVERY_TEST_CONNECTION_INVALID");
  expect(() => recoveryConnections(base + suffix, undefined, name)).toThrow(
    "RECOVERY_TEST_CONNECTION_INVALID",
  );
});
it("constructs only a fresh plain recovery URL while preserving explicit administrator identity", () => {
  expect(
    recoveryConnections(base, "postgres://admin:offline@localhost:5432/mnemic_test", name),
  ).toEqual({
    adminUrl: "postgres://admin:offline@localhost:5432/mnemic_test",
    recoveryUrl: "postgres://admin:offline@localhost:5432/" + name,
  });
});
it.each([
  "postgres://admin:offline@other:5432/mnemic_test",
  "postgres://admin:offline@localhost:5433/mnemic_test",
  "postgres://admin:offline@localhost:5432/mnemic",
  "postgres://admin:offline@localhost:5432/mnemic_test%3Fdatabase%3Dmnemic",
])("refuses a different test endpoint or database %s", (value) => {
  expect(() => recoveryConnections(base, value, name)).toThrow("RECOVERY_TEST_CONNECTION_INVALID");
});
it("refuses caller-chosen restoration database names", () => {
  expect(() => recoveryConnections(base, undefined, "mnemic")).toThrow(
    "RECOVERY_TEST_CONNECTION_INVALID",
  );
});

it.each([
  "postgres://test:offline@localhost:5432/mnemic_test?",
  "postgres://test:offline@localhost:5432/mnemic_test#",
  "file:///mnemic_test",
  "postgres://test@localhost:5432/mnemic_test%3Fdatabase%3Dmnemic",
])("preflight rejects ambiguous configuration %s without database I/O", (value) => {
  expect(() => plainRecoveryTestUrl(value)).toThrow("RECOVERY_TEST_CONNECTION_INVALID");
});
