/** No I/O. Reject startup-parameter overrides before setupTestDb or any client is constructed. */
export function plainRecoveryTestUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      value.includes("?") ||
      value.includes("#") ||
      !/^\/[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(parsed.pathname)
    )
      throw Error();
    return parsed;
  } catch {
    throw Error("RECOVERY_TEST_CONNECTION_INVALID");
  }
}
export function recoveryConnections(testUrl: string, override: string | undefined, name: string) {
  const selected = plainRecoveryTestUrl(override ?? testUrl),
    base = plainRecoveryTestUrl(testUrl);
  if (
    selected.hostname !== base.hostname ||
    (selected.port || "5432") !== (base.port || "5432") ||
    selected.pathname !== base.pathname ||
    !/^mnemic_recovery_[0-9a-f]{32}$/.test(name)
  )
    throw Error("RECOVERY_TEST_CONNECTION_INVALID");
  const adminUrl = selected.toString();
  selected.pathname = "/" + name;
  return Object.freeze({ adminUrl, recoveryUrl: selected.toString() });
}
