import { expect, it, vi } from "vitest";
import postgres from "postgres";
import { setupTestDb } from "./db-helper.js";

it("normal close removes the exact random isolated database from pg_database", async () => {
  // The outer fixture owns its CI container. Native runs only use the explicit test admin.
  const outer = await setupTestDb({ migrate: false });
  const outerUrl = new URL(outer.url);
  const native = outerUrl.pathname === "/mnemic_test";
  let control: postgres.Sql | undefined;
  let fixture: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let name: string | undefined;
  let closed = false;
  try {
    const controlUrl = new URL(native ? process.env.MNEMIC_TEST_ADMIN_URL! : outer.url);
    control = postgres(controlUrl.toString(), { max: 1 });
    if (!native) await control`create database ${control("mnemic_test")}`;
    controlUrl.pathname = "/mnemic_test";
    vi.stubEnv("DATABASE_URL", controlUrl.toString());
    vi.stubEnv("MNEMIC_TEST_ADMIN_URL", controlUrl.toString());
    vi.stubEnv("MNEMIC_FORCE_TESTCONTAINERS", "0");
    vi.resetModules();
    const { setupTestDb: setupPrivateDb } = await import("./db-helper.js");
    fixture = await setupPrivateDb({ isolated: true, migrate: false });
    const createdName = new URL(fixture.url).pathname.slice(1);
    expect(createdName).toMatch(/^mnemic_isolated_[a-f0-9]{32}$/);
    name = createdName;
    expect(await control`select datname from pg_database where datname=${name}`).toHaveLength(1);
    await fixture.sql`select 1`;
    await fixture.close();
    closed = true;
    expect(await control`select datname from pg_database where datname=${name}`).toHaveLength(0);
  } finally {
    if (fixture && !closed) await fixture.close();
    // Only this exact self-created name; also cleans up after a deliberate no-drop mutation.
    if (name && control) await control`drop database if exists ${control(name)}`;
    await control?.end();
    await outer.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}, 180000);
