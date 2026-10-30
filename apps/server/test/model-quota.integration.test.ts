import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createModelQuota, ModelQuotaError } from "../src/quota/repository.js";
import { setupTestDb, migrateAgain, type TestDb } from "./db-helper.js";
let t: TestDb;
let saved: { day: string; calls: string }[];
beforeAll(async () => {
  t = await setupTestDb();
  saved = await t.sql`select day::text,calls::text from model_daily_quota`;
}, 180000);
beforeEach(async () => {
  await t.sql`delete from model_daily_quota`;
});
afterAll(async () => {
  if (t) {
    await t.sql`delete from model_daily_quota`;
    for (const row of saved ?? [])
      await t.sql`insert into model_daily_quota(day,calls) values(${row.day}::date,${row.calls}::bigint)`;
    await t.close();
  }
});
it("concurrent instances admit exactly the cap and preserve the count across connections", async () => {
  const other = postgres(t.url, { max: 2 });
  try {
    const a = createModelQuota(t.db, 3),
      b = createModelQuota(drizzle(other), 3);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b)()),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const denied = results.filter((r) => r.status === "rejected");
    expect(denied).toHaveLength(9);
    for (const r of denied)
      if (r.status === "rejected")
        expect(r.reason).toMatchObject({ statusCode: 429, reason: "exhausted" });
    await expect(createModelQuota(drizzle(other), 3)()).rejects.toBeInstanceOf(ModelQuotaError);
    expect(await t.sql`select calls::int from model_daily_quota`).toEqual([{ calls: 3 }]);
  } finally {
    await other.end();
  }
});
it("the database UTC day starts independently from yesterday and returns a bounded retry delay", async () => {
  await t.sql`insert into model_daily_quota values((clock_timestamp() at time zone 'UTC')::date - 1,999999)`;
  const admit = createModelQuota(t.db, 1);
  await admit();
  const error = await admit().catch((e) => e);
  expect(error).toMatchObject({ statusCode: 429, reason: "exhausted" });
  expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  expect(error.retryAfterSeconds).toBeLessThanOrEqual(86400);
  const rows = await t.sql`select calls::int from model_daily_quota order by day`;
  expect(rows).toEqual([{ calls: 999999 }, { calls: 1 }]);
});
it("lowering the configured limit preserves consumed calls, raising it admits only the difference", async () => {
  await createModelQuota(t.db, 2)();
  await expect(createModelQuota(t.db, 1)()).rejects.toMatchObject({ reason: "exhausted" });
  await createModelQuota(t.db, 2)();
  await expect(createModelQuota(t.db, 2)()).rejects.toMatchObject({ reason: "exhausted" });
  expect(await t.sql`select calls::int from model_daily_quota`).toEqual([{ calls: 2 }]);
});
it("already cancelled invocations do not reserve and invalid configuration cannot become unlimited", async () => {
  await expect(createModelQuota(t.db, 1)(AbortSignal.abort())).rejects.toThrow();
  expect(await t.sql`select * from model_daily_quota`).toEqual([]);
  for (const n of [0, -1, 1.1, NaN, Infinity, 1000001])
    expect(() => createModelQuota(t.db, n)).toThrow();
});
it("database failure is fail-closed with a fixed warning, even if the logger throws", async () => {
  const logs: string[] = [];
  const db = {
    execute: async () => {
      throw Error("sk-private-database-url");
    },
  } as unknown as TestDb["db"];
  const admit = createModelQuota(db, 2, {
    warn: (m) => {
      logs.push(m);
      throw Error("logger-secret");
    },
  });
  const error = await admit().catch((e) => e);
  expect(error).toMatchObject({ reason: "unavailable", statusCode: 503 });
  expect(logs).toEqual(["model daily quota unavailable"]);
  expect(String(error)).not.toMatch(/sk-private|logger-secret/);
});
it("exhaustion warns without any model or request data", async () => {
  const logs: string[] = [];
  const admit = createModelQuota(t.db, 1, { warn: (m) => logs.push(m) });
  await admit();
  await expect(admit()).rejects.toMatchObject({ reason: "exhausted" });
  expect(logs).toEqual(["model daily quota exhausted"]);
});
it("DDL enforces positive safe counters and migrations preserve existing reservations", async () => {
  await createModelQuota(t.db, 3)();
  await migrateAgain(t.db);
  expect(await t.sql`select calls::int from model_daily_quota`).toEqual([{ calls: 1 }]);
  for (const invalid of [0, -1, "9007199254740992"])
    await expect(t.sql`update model_daily_quota set calls=${invalid}`).rejects.toMatchObject({
      code: "23514",
    });
  const cols =
    await t.sql`select column_name from information_schema.columns where table_schema='public' and table_name='model_daily_quota' order by ordinal_position`;
  expect(cols.map((r) => r.column_name)).toEqual(["day", "calls"]);
});
it("UTC quota date is independent of the connection's local day", async () => {
  const dbTime =
    await t.sql`select extract(hour from clock_timestamp() at time zone 'UTC')::int as hour,(clock_timestamp() at time zone 'UTC')::date::text as day`;
  const zone = dbTime[0]!.hour >= 10 ? "Etc/GMT-14" : "Etc/GMT+12";
  const connection = postgres(t.url, { max: 1 });
  try {
    await connection`select set_config('TimeZone',${zone},false)`;
    const local = await connection`select current_date::text as day`;
    expect(local[0]!.day).not.toBe(dbTime[0]!.day);
    await createModelQuota(drizzle(connection), 1)();
    const rows = await t.sql`select day::text from model_daily_quota`;
    expect(rows).toEqual([{ day: dbTime[0]!.day }]);
  } finally {
    await connection.end();
  }
});
