import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * 集成测试双模式（#3）：
 * - 本地：连原生 PG 的独立 mnemic_test 库（不碰开发库数据）
 * - CI / 本地 PG 不可达：自动落回 Testcontainers（pgvector/pgvector:pg17）
 * 可用 MNEMIC_FORCE_TESTCONTAINERS=1 强制容器路径。
 */

const DEV_URL =
  process.env.DATABASE_URL ?? "postgres://mnemic:mnemic@localhost:5432/mnemic";
const TEST_DB_NAME = "mnemic_test";

const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

export interface TestDb {
  db: PostgresJsDatabase;
  sql: postgres.Sql;
  url: string;
  close: () => Promise<void>;
}

function toTestUrl(url: string): string {
  return url.replace(/\/[^/?]+(?=\?|$)/, `/${TEST_DB_NAME}`);
}

async function tryLocal(): Promise<string | null> {
  if (process.env.MNEMIC_FORCE_TESTCONTAINERS === "1") return null;
  const sql = postgres(toTestUrl(DEV_URL), { connect_timeout: 3, max: 1 });
  try {
    await sql`select 1`;
    return toTestUrl(DEV_URL);
  } catch {
    return null;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export async function setupTestDb(): Promise<TestDb> {
  let url = await tryLocal();
  let stop: (() => Promise<void>) | undefined;

  if (!url) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
    url = container.getConnectionUri();
    stop = async () => {
      await container.stop();
    };
  }

  // 迁移串行化：vitest 多测试文件并行 worker 会并发 migrate 同一测试库，
  // CREATE EXTENSION/TYPE 竞态导致 pg_namespace 唯一冲突——advisory lock 互斥。
  // advisory lock key 727272：任意固定常量即可（取 Mnemic 谐音 7 的重复），
  // 只需全仓库唯一使用、不与其他锁冲突。
  const migSql = postgres(url, { max: 1 });
  await migSql`select pg_advisory_lock(727272)`;
  try {
    await migrate(drizzle(migSql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await migSql`select pg_advisory_unlock(727272)`;
    await migSql.end();
  }

  const sql = postgres(url, { max: 4 });
  const db = drizzle(sql);

  return {
    db,
    sql,
    url,
    close: async () => {
      await sql.end();
      await stop?.();
    },
  };
}

/** 迁移幂等性：重复执行 migrate 不得报错（drizzle 迁移表记录已应用批次） */
export async function migrateAgain(db: PostgresJsDatabase): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
