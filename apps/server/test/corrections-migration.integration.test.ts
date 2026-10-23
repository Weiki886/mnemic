import { fileURLToPath } from "node:url";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { setupTestDb, type TestDb } from "./db-helper.js";

describe("专用修正会话迁移（#70）", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb({ migrate: false });
  }, 180_000);
  afterAll(async () => {
    await t?.close();
  });

  it("历史重复项保留 ID/出处/元数据，仅改名；迁移可重复执行", async () => {
    const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
    const migrations = readMigrationFiles({ migrationsFolder });
    const history = migrations.slice(0, 8);
    const target = migrations[8]!;
    const schema = `migration_${uuidv7().replaceAll("-", "")}`;
    const projectId = uuidv7();
    const otherProjectId = uuidv7();
    const later = uuidv7();
    const canonical = "01920000-0000-7000-8000-000000000001";
    const tied = "01920000-0000-7000-8000-000000000002";
    const scoped = postgres(t.url, { max: 1 });
    const fixtureFolder = await mkdtemp(path.join(tmpdir(), "mnemic-migration-0008-"));
    let created = false;
    try {
      // Pin this regression to 0008: future migrations must not mutate its intentionally legacy tables.
      const journal = JSON.parse(
        await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
      );
      journal.entries = journal.entries.slice(0, 9);
      await mkdir(path.join(fixtureFolder, "meta"));
      await writeFile(path.join(fixtureFolder, "meta/_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries as { tag: string }[])
        await copyFile(
          path.join(migrationsFolder, `${entry.tag}.sql`),
          path.join(fixtureFolder, `${entry.tag}.sql`),
        );
      // 独立单连接隔离表和迁移账本；只重定向旧 DDL 的 schema，目标迁移原样执行。
      await scoped.unsafe(`create schema "${schema}"`);
      created = true;
      await scoped.unsafe(`set search_path to "${schema}"`);
      const legacyStatement = (fragment: string) => {
        const statement = history[0]!.sql.find((s) => s.includes(fragment));
        if (!statement) throw new Error(`缺少旧版 DDL：${fragment}`);
        return statement.replaceAll('"public".', `"${schema}".`);
      };
      await scoped.unsafe(legacyStatement('CREATE TYPE "public"."speaker"'));
      for (const table of ["projects", "conversations", "messages"]) {
        await scoped.unsafe(legacyStatement(`CREATE TABLE IF NOT EXISTS "${table}"`));
      }
      for (const constraint of [
        "conversations_project_id_projects_id_fk",
        "messages_conversation_id_conversations_id_fk",
      ]) {
        await scoped.unsafe(legacyStatement(`ADD CONSTRAINT "${constraint}"`));
      }
      // 0005/0006 是截至 0007 的消息表变更：extracted_at 与 memories。
      for (const migration of history.slice(5, 7)) {
        for (const statement of migration.sql) await scoped.unsafe(statement);
      }
      await expect(
        scoped.begin(async (candidate) => {
          await candidate`insert into conversations (id, project_id, title, started_at)
            values (${uuidv7()}, ${uuidv7()}, 'orphan', now())`;
        }),
      ).rejects.toMatchObject({ code: "23503" });
      await scoped`insert into projects (id, name) values
        (${projectId}, 'legacy'), (${otherProjectId}, 'other project')`;
      await scoped`insert into conversations (id, project_id, title, started_at, ended_at, meta) values
        (${later}, ${projectId}, 'manual-corrections', '2026-09-03', '2026-09-05', '{"origin":"later"}'),
        (${canonical}, ${projectId}, 'manual-corrections', '2026-09-01', null, '{"origin":"canonical"}'),
        (${tied}, ${projectId}, 'manual-corrections', '2026-09-01', '2026-09-02', '{"origin":"tied"}'),
        (${uuidv7()}, ${otherProjectId}, 'manual-corrections', '2026-09-01', null, '{}'),
        (${uuidv7()}, ${projectId}, 'same title', '2026-09-01', null, '{}'),
        (${uuidv7()}, ${projectId}, 'same title', '2026-09-01', null, '{}')`;
      await scoped`insert into messages
        (id, conversation_id, speaker, raw_text, msg_time, extracted_at, memories) values
        (${uuidv7()}, ${later}, 'user', 'later correction', '2026-09-03', '2026-09-04', '[]'),
        (${uuidv7()}, ${canonical}, 'user', 'first correction', '2026-09-01', null, null),
        (${uuidv7()}, ${tied}, 'tool', 'tied correction', '2026-09-01', null, '[]')`;
      const before = await scoped`select * from conversations order by id`;
      const messages = await scoped`select * from messages order by id`;
      const expected = before.map((row) => ({
        ...row,
        title:
          row.id === later || row.id === tied ? `manual-corrections:legacy:${row.id}` : row.title,
      }));

      // 私有账本模拟已升级至 0007；迁移器读取原始目录、按断点事务执行 0008。
      await scoped.unsafe(`create table __drizzle_migrations (
        id serial primary key, hash text not null, created_at bigint
      )`);
      for (const migration of history) {
        await scoped`insert into __drizzle_migrations (hash, created_at)
          values (${migration.hash}, ${migration.folderMillis})`;
      }
      const config = { migrationsFolder: fixtureFolder, migrationsSchema: schema };
      await migrate(drizzle(scoped), config);
      expect(await scoped`select * from conversations order by id`).toEqual(expected);
      expect(await scoped`select * from messages order by id`).toEqual(messages);
      const ledger =
        await scoped`select hash, created_at from __drizzle_migrations order by created_at`;
      expect(ledger).toHaveLength(9);
      expect(ledger[8]!.hash).toBe(target.hash);
      expect(Number(ledger[8]!.created_at)).toBe(target.folderMillis);
      await migrate(drizzle(scoped), config);
      expect(
        await scoped`select hash, created_at from __drizzle_migrations order by created_at`,
      ).toEqual(ledger);
      // 另保留直接重放 SQL 的幂等检查（迁移器重复调用会按账本跳过）。
      await scoped.begin(async (transaction) => {
        for (const statement of target.sql) await transaction.unsafe(statement);
      });
      expect(await scoped`select * from conversations order by id`).toEqual(expected);
      expect(await scoped`select * from messages order by id`).toEqual(messages);

      await expect(
        scoped.begin(async (candidate) => {
          await candidate`insert into conversations (id, project_id, title, started_at)
          values (${uuidv7()}, ${projectId}, 'manual-corrections', now())`;
        }),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      try {
        await scoped.unsafe("reset search_path");
        if (created) await scoped.unsafe(`drop schema "${schema}" cascade`);
      } finally {
        await scoped.end();
        await rm(fixtureFolder, { recursive: true, force: true });
      }
    }
  });
});
