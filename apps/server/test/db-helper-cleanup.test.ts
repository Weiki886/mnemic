import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: vi.fn(), migrate: vi.fn() }));
vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: (sql: unknown) => sql }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: mocks.migrate }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it.each(["lock", "unlock"])(
  "closes migration connections before dropping its private DB on %s failure",
  async (failure) => {
    vi.stubEnv("MNEMIC_FORCE_TESTCONTAINERS", "0");
    vi.stubEnv("MNEMIC_TEST_ADMIN_URL", "postgres://offline@localhost:5432/mnemic_test");
    const problem = Error("offline migration failure");
    let migrationClosed = false;
    const probe = Object.assign(
      vi.fn(async () => []),
      { end: vi.fn(async () => {}) },
    );
    const admin = Object.assign(
      vi.fn(async (parts: TemplateStringsArray | string) => {
        if (typeof parts === "string") return parts;
        if (parts[0]?.startsWith("drop database")) expect(migrationClosed).toBe(true);
        return [];
      }),
      { end: vi.fn(async () => {}) },
    );
    const migration = Object.assign(
      vi.fn(async (parts: TemplateStringsArray) => {
        const isUnlock = parts[0]?.includes("pg_advisory_unlock");
        if ((failure === "unlock") === isUnlock) throw problem;
        return [];
      }),
      {
        end: vi.fn(async () => {
          migrationClosed = true;
        }),
      },
    );
    mocks.postgres
      .mockReturnValueOnce(probe)
      .mockReturnValueOnce(admin)
      .mockReturnValueOnce(migration);
    const { setupTestDb } = await import("./db-helper.js");
    await expect(setupTestDb({ isolated: true })).rejects.toBe(problem);
    expect(migration.end).toHaveBeenCalledOnce();
    expect(admin.end).toHaveBeenCalledOnce();
    expect(
      admin.mock.calls.some(
        ([parts]) => typeof parts !== "string" && parts[0]?.startsWith("drop database"),
      ),
    ).toBe(true);
  },
);
