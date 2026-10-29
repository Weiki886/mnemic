import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { DEFAULT_FEATURE_FLAGS } from "../../../packages/shared/src/flags.js";
import { readFeatureFlags, updateFeatureFlags } from "../src/flags/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
let saved: {
  schema_version: number;
  revision: string;
  flags: Record<string, boolean>;
  updated_at: Date;
};
beforeAll(async () => {
  t = await setupTestDb();
  [saved] =
    (await t.sql`select schema_version,revision::text,flags,updated_at from feature_flags where scope='server'`) as [
      typeof saved,
    ];
}, 180000);
beforeEach(async () => {
  await t.sql`update feature_flags set schema_version=1,revision=0,flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb where scope='server'`;
});
afterAll(async () => {
  if (t) {
    if (saved)
      await t.sql`update feature_flags set schema_version=${saved.schema_version},revision=${saved.revision},flags=${JSON.stringify(saved.flags)}::jsonb,updated_at=${saved.updated_at} where scope='server'`;
    await t.close();
  }
});
async function auditRows() {
  return t.sql`select * from audit_log where actor='server' and action='flags.update' and target='server' order by ts,id`;
}
const changed = () => ({ ...DEFAULT_FEATURE_FLAGS, memory_gate: false });
it("migration seeds v1 defaults once and raw SQL replay preserves later configuration", async () => {
  expect(await readFeatureFlags(t.db)).toEqual({
    schema_version: 1,
    revision: 0,
    flags: DEFAULT_FEATURE_FLAGS,
  });
  await updateFeatureFlags(t.db, { expected_revision: 0, flags: changed() });
  const script = await readFile(
    new URL("../drizzle/0013_feature_flags.sql", import.meta.url),
    "utf8",
  );
  for (const statement of script.split("--> statement-breakpoint"))
    if (statement.trim()) await t.sql.unsafe(statement);
  const state = await readFeatureFlags(t.db);
  expect(state.revision).toBe(1);
  expect(state.flags.memory_gate).toBe(false);
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.flags)).toBe(true);
});
it("eight same-revision writers yield exactly one change and one complete audit", async () => {
  const before = await auditRows();
  // Hold a real row lock until at least two contenders are waiting. This tests contention,
  // even when a cold connection pool would otherwise serialize the first writes accidentally.
  const blocker = postgres(t.url, { max: 1 });
  let pending: Promise<Awaited<ReturnType<typeof updateFeatureFlags>>[]> | undefined;
  let results: Awaited<ReturnType<typeof updateFeatureFlags>>[];
  try {
    await blocker.begin(async (locked) => {
      await locked`select id from feature_flags where scope='server' for update`;
      pending = Promise.all(
        Array.from({ length: 8 }, () =>
          updateFeatureFlags(t.db, { expected_revision: 0, flags: changed() }),
        ),
      );
      await vi.waitFor(
        async () => {
          await locked`select pg_stat_clear_snapshot()`;
          const [row] =
            await locked`select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%feature_flags%'`;
          expect(row!.n).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5000 },
      );
    });
    results = await pending!;
  } finally {
    await pending?.catch(() => {});
    await blocker.end();
  }
  expect(results.filter((r) => r.kind === "updated")).toHaveLength(1);
  expect(results.filter((r) => r.kind === "conflict")).toHaveLength(7);
  expect((await readFeatureFlags(t.db)).revision).toBe(1);
  const inserted = (await auditRows()).filter((r) => !before.some((b) => b.id === r.id));
  expect(inserted).toHaveLength(1);
  expect(inserted[0]!.meta).toEqual({
    schema_version: 1,
    previous_revision: 0,
    revision: 1,
    before: DEFAULT_FEATURE_FLAGS,
    after: changed(),
  });
  expect(inserted[0]!.decision).toBe("updated");
});
it("no-op and stale changes cannot increment revisions or append misleading audit rows", async () => {
  const before = (await auditRows()).length;
  expect(
    (await updateFeatureFlags(t.db, { expected_revision: 0, flags: { ...DEFAULT_FEATURE_FLAGS } }))
      .kind,
  ).toBe("unchanged");
  expect((await auditRows()).length).toBe(before);
  await updateFeatureFlags(t.db, { expected_revision: 0, flags: changed() });
  const stale = await updateFeatureFlags(t.db, {
    expected_revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS },
  });
  expect(stale.kind).toBe("conflict");
  expect(stale.snapshot.revision).toBe(1);
  expect(stale.snapshot.flags.memory_gate).toBe(false);
  expect((await auditRows()).length).toBe(before + 1);
});
it("caller mutation after dispatch cannot change the pending update identity or flags", async () => {
  const input = { expected_revision: 0, flags: changed() };
  const result = updateFeatureFlags(t.db, input);
  input.expected_revision = 100;
  input.flags.memory_gate = true;
  expect((await result).snapshot).toMatchObject({ revision: 1, flags: { memory_gate: false } });
});
it("audit insert failure rolls the configuration update back", async () => {
  const before = (await auditRows()).length;
  await t.sql`alter table audit_log add constraint feature_flags_test_audit_reject check (action <> 'flags.update') not valid`;
  try {
    await expect(
      updateFeatureFlags(t.db, { expected_revision: 0, flags: changed() }),
    ).rejects.toThrow();
  } finally {
    await t.sql`alter table audit_log drop constraint feature_flags_test_audit_reject`;
  }
  expect(await readFeatureFlags(t.db)).toEqual({
    schema_version: 1,
    revision: 0,
    flags: DEFAULT_FEATURE_FLAGS,
  });
  expect((await auditRows()).length).toBe(before);
});
it("a new database connection observes the same persisted revision and values", async () => {
  await updateFeatureFlags(t.db, { expected_revision: 0, flags: changed() });
  const connection = postgres(t.url, { max: 1 });
  try {
    expect(await readFeatureFlags(drizzle(connection))).toEqual({
      schema_version: 1,
      revision: 1,
      flags: changed(),
    });
  } finally {
    await connection.end();
  }
});
it.each([
  { flags: { ...DEFAULT_FEATURE_FLAGS, unknown: false } },
  { flags: { ...DEFAULT_FEATURE_FLAGS, memory_gate: "false" } },
  { flags: { memory_gate: true } },
  { flags: null },
  { revision: -1 },
  { revision: "9007199254740992" },
  { schema_version: 2 },
  { scope: "other" },
])("PG rejects invalid direct configuration updates %j", async (fields) => {
  await expect(
    t.sql`update feature_flags set ${t.sql(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === "flags" ? JSON.stringify(v) : v])))} where scope='server'`,
  ).rejects.toMatchObject({ code: "23514" });
});
it("revision exhaustion fails without changing config or audit", async () => {
  await t.sql`update feature_flags set revision=9007199254740991 where scope='server'`;
  const before = (await auditRows()).length;
  await expect(
    updateFeatureFlags(t.db, { expected_revision: Number.MAX_SAFE_INTEGER, flags: changed() }),
  ).rejects.toThrow("feature flag revision exhausted");
  expect((await readFeatureFlags(t.db)).revision).toBe(Number.MAX_SAFE_INTEGER);
  expect((await auditRows()).length).toBe(before);
});
it("missing configuration fails closed rather than silently claiming default behavior", async () => {
  const before = await readFeatureFlags(t.db);
  await expect(
    t.db.transaction(async (tx) => {
      await tx.execute(sql`delete from feature_flags where scope='server'`);
      await expect(readFeatureFlags(tx)).rejects.toThrow("invalid feature flag configuration");
      await expect(
        updateFeatureFlags(tx, { expected_revision: 0, flags: changed() }),
      ).rejects.toThrow("invalid feature flag configuration");
      throw Error("rollback fixture");
    }),
  ).rejects.toThrow("rollback fixture");
  expect(await readFeatureFlags(t.db)).toEqual(before);
});

it("singleton scope cannot acquire a second row", async () => {
  await expect(
    t.sql`insert into feature_flags(id,scope,flags) values('01a18076-f23c-7f63-8b88-e788f3cfef98','server',${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb)`,
  ).rejects.toMatchObject({ code: "23505" });
});
it("outer transaction rollback removes both config and its successful audit insert", async () => {
  const before = (await auditRows()).length;
  await expect(
    t.db.transaction(async (tx) => {
      await updateFeatureFlags(tx, { expected_revision: 0, flags: changed() });
      throw Error("outer rollback");
    }),
  ).rejects.toThrow("outer rollback");
  expect((await readFeatureFlags(t.db)).revision).toBe(0);
  expect((await auditRows()).length).toBe(before);
});
