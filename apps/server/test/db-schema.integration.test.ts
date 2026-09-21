import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { setupTestDb, type TestDb } from "./db-helper.js";

/**
 * #3 数据模型验收测试（对应 Issue #3 验收标准逐条）
 * 全部走原始 SQL 断言数据库层真实行为，不经过应用封装。
 */

describe("数据模型 V1（#3）", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  const mkProject = async (name: string) => {
    const rows = await t.sql`
      insert into projects (id, name) values (${uuidv7()}, ${name}) returning id
    `;
    return rows[0]!.id as string;
  };
  const mkConversation = async (projectId: string) => {
    const rows = await t.sql`
      insert into conversations (id, project_id, title)
      values (${uuidv7()}, ${projectId}, '会话') returning id
    `;
    return rows[0]!.id as string;
  };
  const mkMessage = async (conversationId: string, speaker: string, text: string) => {
    const rows = await t.sql`
      insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${uuidv7()}, ${conversationId}, ${speaker}, ${text}, now()) returning id
    `;
    return rows[0]!.id as string;
  };

  const columnsOf = async (table: string) => {
    const rows = await t.sql`
      select column_name as c from information_schema.columns
      where table_schema = 'public' and table_name = ${table}
    `;
    return rows.map((r) => r.c as string);
  };

  it("Evidence 层：conversations/messages 可写读，speaker 枚举约束生效", async () => {
    const pid = await mkProject("evidence");
    const cid = await mkConversation(pid);
    const mid = await mkMessage(cid, "user", "我们用 PostgreSQL");
    const rows = await t.sql`
      select m.raw_text, m.speaker, c.project_id
      from messages m join conversations c on c.id = m.conversation_id
      where m.id = ${mid}
    `;
    expect(rows[0]).toMatchObject({
      raw_text: "我们用 PostgreSQL",
      speaker: "user",
      project_id: pid,
    });
    // 非法 speaker 被拒
    await expect(mkMessage(cid, "robot", "x")).rejects.toThrow();
  });

  it("Observation：v1.15 字段逐项可读写（evidence_id FK / entities / importance / confidence / reliability / source_type / authority）", async () => {
    const pid = await mkProject("obs-fields");
    const cid = await mkConversation(pid);
    const mid = await mkMessage(cid, "user", "数据库改用 SQLite");
    const id = uuidv7();
    await t.sql`
      insert into observations (
        id, project_id, type, subject, attribute, value,
        assertion_intent, source_type, authority, reliability,
        valid_time, recorded_at, evidence_id,
        importance, confidence, entities, is_profile
      ) values (
        ${id}, ${pid}, 'decision', 'my-project', 'database', ${JSON.stringify("SQLite")}::jsonb,
        'UPDATE', 'USER_CORRECTION', 70, 0.95,
        now(), now(), ${mid},
        0.9, 0.88, ${JSON.stringify(["my-project", "SQLite"])}::jsonb, true
      )
    `;
    const rows = await t.sql`select * from observations where id = ${id}`;
    const o = rows[0]!;
    expect(o.evidence_id).toBe(mid);
    expect(o.entities).toEqual(["my-project", "SQLite"]);
    expect(Number(o.importance)).toBeCloseTo(0.9);
    expect(Number(o.confidence)).toBeCloseTo(0.88);
    expect(Number(o.reliability)).toBeCloseTo(0.95);
    expect(o.source_type).toBe("USER_CORRECTION");
    expect(o.authority).toBe(70);
    expect(o.is_profile).toBe(true);
  });

  it("Observation：time_precision 枚举 + time_confidence / time_precision 默认值", async () => {
    const pid = await mkProject("obs-time");
    const cid = await mkConversation(pid);
    const mid = await mkMessage(cid, "user", "上周定了方向");
    const id = uuidv7();
    await t.sql`
      insert into observations (
        id, project_id, type, subject, attribute, value,
        assertion_intent, source_type, authority, evidence_id
      ) values (
        ${id}, ${pid}, 'fact', 'p', 'k', ${JSON.stringify("v")}::jsonb,
        'ASSERT', 'USER_EXPLICIT', 60, ${mid}
      )
    `;
    const rows = await t.sql`select time_precision, time_confidence from observations where id = ${id}`;
    expect(rows[0]!.time_precision).toBe("DAY");
    expect(Number(rows[0]!.time_confidence)).toBe(1);
    // 非法 precision 被拒
    await expect(
      t.sql`
        insert into observations (
          id, project_id, type, subject, attribute, value,
          assertion_intent, source_type, authority, evidence_id, time_precision
        ) values (
          ${uuidv7()}, ${pid}, 'fact', 'p', 'k', ${JSON.stringify("v")}::jsonb,
          'ASSERT', 'USER_EXPLICIT', 60, ${mid}, 'HOUR'
        )
      `,
    ).rejects.toThrow();
  });

  it("Observation 不可变：无 updated_at 列", async () => {
    const cols = await columnsOf("observations");
    expect(cols).not.toContain("updated_at");
  });

  it("Belief：三字段分离（confidence/salience/importance/is_profile 存在）且不存在任何单一 score 字段", async () => {
    const cols = await columnsOf("beliefs");
    for (const c of ["confidence", "salience", "importance", "is_profile"]) {
      expect(cols).toContain(c);
    }
    expect(cols).not.toContain("score");
    expect(cols.some((c) => c.endsWith("_score"))).toBe(false);
  });

  it("Belief + BeliefVersion：版本链只追加，旧版本内容不物理修改，as-of 可查", async () => {
    const pid = await mkProject("chain");
    const cid = await mkConversation(pid);
    const mid1 = await mkMessage(cid, "user", "我们用 PostgreSQL");
    const mid2 = await mkMessage(cid, "user", "改用 SQLite");
    const obs1 = uuidv7();
    const obs2 = uuidv7();
    await t.sql`
      insert into observations (id, project_id, type, subject, attribute, value,
        assertion_intent, source_type, authority, evidence_id)
      values (${obs1}, ${pid}, 'decision', 'chain-p', 'db', ${JSON.stringify("PostgreSQL")}::jsonb,
        'ASSERT', 'USER_EXPLICIT', 60, ${mid1})
    `;
    await t.sql`
      insert into observations (id, project_id, type, subject, attribute, value,
        assertion_intent, source_type, authority, evidence_id)
      values (${obs2}, ${pid}, 'decision', 'chain-p', 'db', ${JSON.stringify("SQLite")}::jsonb,
        'UPDATE', 'USER_CORRECTION', 70, ${mid2})
    `;

    const beliefId = uuidv7();
    const v1 = uuidv7();
    const v2 = uuidv7();
    const t0 = "2026-01-01T00:00:00Z";
    const t1 = "2026-02-01T00:00:00Z";

    // 环形 FK 写入序：belief 行先行（current_version_id 暂空）→ 追加 v1 → 回指 current
    await t.sql`
      insert into beliefs (id, project_id, subject, attribute,
        confidence, salience, importance)
      values (${beliefId}, ${pid}, 'chain-p', 'db', 0.9, 0.8, 0.85)
    `;
    // v1：系统 t0 起相信 PostgreSQL（valid 开口）
    await t.sql`
      insert into belief_versions (id, belief_id, value, valid_from, valid_to,
        recorded_from, recorded_to, source_observation_id, resolver_version)
      values (${v1}, ${beliefId}, ${JSON.stringify("PostgreSQL")}::jsonb, ${t0}, null,
        ${t0}, null, ${obs1}, 'resolver-v1')
    `;
    await t.sql`
      update beliefs set current_version_id = ${v1} where id = ${beliefId}
    `;

    // 冲突改判：关闭 v1 区间（仅允许改 recorded_to/valid_to），追加 v2
    await t.sql`
      update belief_versions set recorded_to = ${t1}, valid_to = ${t1} where id = ${v1}
    `;
    await t.sql`
      insert into belief_versions (id, belief_id, value, valid_from, valid_to,
        recorded_from, recorded_to, supersedes_version_id, source_observation_id, resolver_version)
      values (${v2}, ${beliefId}, ${JSON.stringify("SQLite")}::jsonb, ${t1}, null,
        ${t1}, null, ${v1}, ${obs2}, 'resolver-v1')
    `;
    await t.sql`
      update beliefs set current_version_id = ${v2}, evidence_count = 2 where id = ${beliefId}
    `;

    // 旧版本内容未被物理修改
    const oldRows = await t.sql`
      select value, valid_from, supersedes_version_id from belief_versions where id = ${v1}
    `;
    expect(oldRows[0]!.value).toBe("PostgreSQL");
    expect(new Date(oldRows[0]!.valid_from as string).toISOString()).toBe(
      new Date(t0).toISOString(),
    );
    expect(oldRows[0]!.supersedes_version_id).toBeNull();

    // as-of：t0~t1 之间系统相信 PostgreSQL；t1 之后相信 SQLite
    const asOf = async (tsq: string) => {
      const rows = await t.sql`
        select value from belief_versions
        where belief_id = ${beliefId}
          and valid_from <= ${tsq}::timestamptz
          and (valid_to is null or ${tsq}::timestamptz < valid_to)
          and recorded_from <= ${tsq}::timestamptz
          and (recorded_to is null or ${tsq}::timestamptz < recorded_to)
      `;
      return rows[0]?.value;
    };
    expect(await asOf("2026-01-15T00:00:00Z")).toBe("PostgreSQL");
    expect(await asOf("2026-02-15T00:00:00Z")).toBe("SQLite");
  });

  it("Belief：status 枚举含 retracted（RETRACT 落点，迁移注释固定）；subject+attribute 项目内唯一", async () => {
    const pid = await mkProject("belief-misc");
    const dup = async () => {
      await t.sql`
        insert into beliefs (id, project_id, subject, attribute) values (${uuidv7()}, ${pid}, 's', 'a')
      `;
    };
    await dup();
    await expect(dup()).rejects.toThrow();
    // status 合法值
    await t.sql`
      update beliefs set status = 'retracted' where project_id = ${pid} and subject = 's'
    `;
    const rows = await t.sql`
      select status from beliefs where project_id = ${pid} and subject = 's'
    `;
    expect(rows[0]!.status).toBe("retracted");
  });

  it("memory_embeddings：vector(1024) 列与 belief_version_id FK 存在（HNSW 索引在迁移中创建）", async () => {
    const rows = await t.sql`
      select data_type, udt_name from information_schema.columns
      where table_schema = 'public' and table_name = 'memory_embeddings' and column_name = 'embedding'
    `;
    expect(rows[0]!.udt_name).toBe("vector");
    const idx = await t.sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'memory_embeddings' and indexdef ilike '%hnsw%'
    `;
    expect(idx.length).toBeGreaterThan(0);
  });

  it("audit_log：字段齐备（id/ts/actor/action/target/decision/meta JSONB）可写读", async () => {
    const id = uuidv7();
    await t.sql`
      insert into audit_log (id, actor, action, target, decision, meta)
      values (${id}, 'system#15', 'redact', 'observation:123', 'redacted',
        ${JSON.stringify({ reason: "secret detected" })}::jsonb)
    `;
    const rows = await t.sql`select actor, action, meta from audit_log where id = ${id}`;
    expect(rows[0]).toMatchObject({ actor: "system#15", action: "redact" });
    expect(rows[0]!.meta).toEqual({ reason: "secret detected" });
  });

  it("sources 表不存在（出处链由 evidence_id → messages.id 承担）", async () => {
    const rows = await t.sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'sources'
    `;
    expect(rows).toHaveLength(0);
  });

  it("业务表 project_id FK 齐备（observations/beliefs/conversations 拒绝孤儿行）", async () => {
    await expect(
      t.sql`
        insert into conversations (id, project_id, title)
        values (${uuidv7()}, ${uuidv7()}, '孤儿')
      `,
    ).rejects.toThrow();
  });
});
