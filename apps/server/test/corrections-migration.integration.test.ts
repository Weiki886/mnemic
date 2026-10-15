import { readFile } from "node:fs/promises";
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
    const migration = await readFile(
      new URL("../drizzle/0008_manual_corrections_unique.sql", import.meta.url),
      "utf8",
    );
    const schema = `migration_${uuidv7().replaceAll("-", "")}`;
    const projectId = uuidv7();
    const otherProjectId = uuidv7();
    const later = uuidv7();
    const canonical = "01920000-0000-7000-8000-000000000001";
    const tied = "01920000-0000-7000-8000-000000000002";
    await t.sql.begin(async (scoped) => {
      // 隔离旧版表结构，完全不动 public 中的真实测试数据或迁移账本。
      await scoped.unsafe(`create schema "${schema}"`);
      await scoped.unsafe(`set local search_path to "${schema}"`);
      await scoped.unsafe(`create table conversations (
        id uuid primary key, project_id uuid not null, title text,
        started_at timestamptz not null, ended_at timestamptz, meta jsonb
      )`);
      await scoped.unsafe(`create table messages (
        id uuid primary key, conversation_id uuid references conversations(id), raw_text text
      )`);
      await scoped`insert into conversations (id, project_id, title, started_at, ended_at, meta) values
        (${later}, ${projectId}, 'manual-corrections', '2026-09-03', '2026-09-05', '{"origin":"later"}'),
        (${canonical}, ${projectId}, 'manual-corrections', '2026-09-01', null, '{"origin":"canonical"}'),
        (${tied}, ${projectId}, 'manual-corrections', '2026-09-01', '2026-09-02', '{"origin":"tied"}'),
        (${uuidv7()}, ${otherProjectId}, 'manual-corrections', '2026-09-01', null, '{}'),
        (${uuidv7()}, ${projectId}, 'same title', '2026-09-01', null, '{}'),
        (${uuidv7()}, ${projectId}, 'same title', '2026-09-01', null, '{}')`;
      await scoped`insert into messages (id, conversation_id, raw_text) values
        (${uuidv7()}, ${later}, 'later correction'), (${uuidv7()}, ${canonical}, 'first correction'),
        (${uuidv7()}, ${tied}, 'tied correction')`;
      const before = await scoped`select * from conversations order by id`;
      const messages = await scoped`select * from messages order by id`;
      const expected = before.map((row) => ({
        ...row,
        title:
          row.id === later || row.id === tied ? `manual-corrections:legacy:${row.id}` : row.title,
      }));

      await expect(
        scoped.savepoint(async (candidate) => {
          await candidate.unsafe(migration);
        }),
      ).resolves.toBeUndefined();
      expect(await scoped`select * from conversations order by id`).toEqual(expected);
      expect(await scoped`select * from messages order by id`).toEqual(messages);
      await scoped.unsafe(migration);
      expect(await scoped`select * from conversations order by id`).toEqual(expected);

      await expect(
        scoped.savepoint(async (candidate) => {
          await candidate`insert into conversations (id, project_id, title, started_at)
          values (${uuidv7()}, ${projectId}, 'manual-corrections', now())`;
        }),
      ).rejects.toMatchObject({ code: "23505" });
      // 清理的只是当前事务内创建的、具名隔离测试 schema。
      await scoped.unsafe(`drop schema "${schema}" cascade`);
    });
  });
});
