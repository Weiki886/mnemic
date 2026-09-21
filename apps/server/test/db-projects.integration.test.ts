import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { migrateAgain, setupTestDb, type TestDb } from "./db-helper.js";

describe("projects 表（#3 管道打通）", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  it("迁移可重复执行（幂等）", async () => {
    await expect(migrateAgain(t.db)).resolves.toBeUndefined();
  });

  it("projects 表存在，可插入并按 id 读回", async () => {
    const rows = await t.sql`
      insert into projects (id, name) values (${uuidv7()}, '毕设项目') returning id, name
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("毕设项目");
    const found = await t.sql`select name from projects where id = ${rows[0]!.id}`;
    expect(found[0]!.name).toBe("毕设项目");
  });
});
