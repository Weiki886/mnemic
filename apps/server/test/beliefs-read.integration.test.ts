import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

/** 记忆中心只读 API + 基础软删除（#8）：列表/详情/版本时间线/删除/恢复 */
describe("记忆只读 API 与软删除（#8）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let projectId: string;
  let otherProjectId: string;
  // 主测试信念：两版本（MySQL → PostgreSQL），来源锚到 conv1 的用户消息
  let beliefId: string;
  let v1Id: string;
  let v2Id: string;
  let conv1Id: string;
  let msg1Id: string;
  let profileBeliefId: string;
  let deletedBeliefId: string;

  const seedBelief = async (opts: {
    subject: string;
    attribute: string;
    value: string;
    status?: string;
    isProfile?: boolean;
    project?: string;
  }) => {
    const id = uuidv7();
    const vid = uuidv7();
    const pid = opts.project ?? projectId;
    const cid = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${pid})`;
    const mid = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${mid}, ${cid}, 'user', ${opts.value}, now())`;
    const oid = uuidv7();
    await t.sql`insert into observations
      (id, project_id, type, subject, attribute, value, assertion_intent, source_type, authority, evidence_id, valid_time)
      values (${oid}, ${pid}, 'fact', ${opts.subject}, ${opts.attribute}, ${JSON.stringify(opts.value)}, 'ASSERT', 'USER_EXPLICIT', 60, ${mid}, '2026-09-01')`;
    await t.sql`insert into beliefs (id, project_id, subject, attribute, confidence, salience, importance, is_profile, status)
      values (${id}, ${pid}, ${opts.subject}, ${opts.attribute}, 0.8, 0.5, 0.8, ${opts.isProfile ?? false}, ${opts.status ?? "active"})`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from, source_observation_id, confidence)
      values (${vid}, ${id}, ${JSON.stringify(opts.value)}, '2026-09-01', now(), ${oid}, 0.8)`;
    await t.sql`update beliefs set current_version_id = ${vid} where id = ${id}`;
    return { id, vid, cid, mid };
  };

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    otherProjectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'read-api')`;
    await t.sql`insert into projects (id, name) values (${otherProjectId}, 'read-api-other')`;

    // 主信念：v1 = MySQL（2026-09-01 起），v2 = PostgreSQL（2026-09-10 起，supersede v1）
    beliefId = uuidv7();
    conv1Id = uuidv7();
    await t.sql`insert into conversations (id, project_id, title) values (${conv1Id}, ${projectId}, 'db-choice')`;
    msg1Id = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${msg1Id}, ${conv1Id}, 'user', '数据库用 MySQL', '2026-09-01T08:00:00Z')`;
    const msg2Id = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${msg2Id}, ${conv1Id}, 'user', '换成 PostgreSQL', '2026-09-10T08:00:00Z')`;
    const obs1 = uuidv7();
    await t.sql`insert into observations
      (id, project_id, type, subject, attribute, value, assertion_intent, source_type, authority, evidence_id, valid_time)
      values (${obs1}, ${projectId}, 'decision', 'my-project', 'database', ${JSON.stringify("MySQL")}, 'ASSERT', 'USER_EXPLICIT', 60, ${msg1Id}, '2026-09-01')`;
    const obs2 = uuidv7();
    await t.sql`insert into observations
      (id, project_id, type, subject, attribute, value, assertion_intent, source_type, authority, evidence_id, valid_time)
      values (${obs2}, ${projectId}, 'decision', 'my-project', 'database', ${JSON.stringify("PostgreSQL")}, 'UPDATE', 'USER_EXPLICIT', 60, ${msg2Id}, '2026-09-10')`;
    await t.sql`insert into beliefs (id, project_id, subject, attribute, confidence, salience, importance)
      values (${beliefId}, ${projectId}, 'my-project', 'database', 0.9, 0.6, 0.9)`;
    v1Id = uuidv7();
    v2Id = uuidv7();
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, valid_to, recorded_from, recorded_to, source_observation_id, confidence)
      values (${v1Id}, ${beliefId}, ${JSON.stringify("MySQL")}, '2026-09-01', '2026-09-10', '2026-09-01T08:00:00Z', '2026-09-10T08:00:00Z', ${obs1}, 0.7)`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from, supersedes_version_id, source_observation_id, confidence)
      values (${v2Id}, ${beliefId}, ${JSON.stringify("PostgreSQL")}, '2026-09-10', '2026-09-10T08:00:00Z', ${v1Id}, ${obs2}, 0.9)`;
    await t.sql`update beliefs set current_version_id = ${v2Id} where id = ${beliefId}`;

    profileBeliefId = (
      await seedBelief({
        subject: "weiki",
        attribute: "editor",
        value: "Neovim",
        isProfile: true,
      })
    ).id;
    deletedBeliefId = (
      await seedBelief({
        subject: "my-project",
        attribute: "linter",
        value: "ESLint",
        status: "deleted",
      })
    ).id;
    await seedBelief({ subject: "other", attribute: "x", value: "y", project: otherProjectId });

    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it("列表：默认只返回 active，且带当前值", async () => {
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/beliefs` });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { id: string; status: string; current_value: unknown }[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(beliefId);
    expect(ids).toContain(profileBeliefId);
    expect(ids).not.toContain(deletedBeliefId); // 软删除默认不出现在列表
    const main = rows.find((r) => r.id === beliefId)!;
    expect(main.current_value).toBe("PostgreSQL");
  });

  it("列表：status/profile/q 过滤 + 项目隔离", async () => {
    const deleted = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs?status=deleted`,
    });
    const deletedIds = (deleted.json() as { id: string }[]).map((r) => r.id);
    expect(deletedIds).toEqual([deletedBeliefId]);

    const profile = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs?profile=true`,
    });
    expect((profile.json() as { id: string }[]).map((r) => r.id)).toEqual([profileBeliefId]);

    const searched = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs?q=datab`,
    });
    expect((searched.json() as { id: string }[]).map((r) => r.id)).toEqual([beliefId]);

    // 通配符转义：% / _ 是字面量不是通配符，q=% 不该匹配所有行
    const wildcard = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs?q=${encodeURIComponent("%")}`,
    });
    expect(wildcard.json()).toEqual([]);
    const underscore = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs?q=${encodeURIComponent("_")}`,
    });
    expect(underscore.json()).toEqual([]);

    // 项目隔离：other 项目的信念不会混入
    const other = await app.inject({
      method: "GET",
      url: `/projects/${otherProjectId}/beliefs`,
    });
    expect((other.json() as { subject: string }[]).map((r) => r.subject)).toEqual(["other"]);
  });

  it("详情：当前值 + 版本时间线（含来源会话跳转锚点）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs/${beliefId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      current_value: unknown;
      versions: {
        id: string;
        value: unknown;
        valid_from: string;
        valid_to: string | null;
        recorded_from: string;
        recorded_to: string | null;
        supersedes_version_id: string | null;
        source: { observation_id: string; message_id: string; conversation_id: string } | null;
      }[];
    };
    expect(body.current_value).toBe("PostgreSQL");
    expect(body.versions.length).toBe(2);
    const [v1, v2] = body.versions;
    expect(v1!.id).toBe(v1Id);
    expect(v1!.value).toBe("MySQL");
    expect(v1!.valid_to).not.toBeNull(); // 双时态区间关闭可读
    expect(v2!.supersedes_version_id).toBe(v1Id);
    // 来源会话跳转：版本 → observation → 消息 → 会话
    expect(v1!.source).toEqual({
      observation_id: expect.any(String),
      message_id: msg1Id,
      conversation_id: conv1Id,
    });
  });

  it("详情：不存在 → 404 problem+json", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs/${uuidv7()}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("详情：跨项目访问 → 404（不泄露存在性）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/projects/${otherProjectId}/beliefs/${beliefId}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("参数校验：非法 UUID → 400", async () => {
    const badProject = await app.inject({
      method: "GET",
      url: `/projects/not-a-uuid/beliefs`,
    });
    expect(badProject.statusCode).toBe(400);
    const badBelief = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs/not-a-uuid`,
    });
    expect(badBelief.statusCode).toBe(400);
    const badDelete = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/beliefs/not-a-uuid/delete`,
    });
    expect(badDelete.statusCode).toBe(400);
  });

  it("列表分页：limit/offset 生效，limit 上限 1000", async () => {
    const paged = uuidv7();
    await t.sql`insert into projects (id, name) values (${paged}, 'paged')`;
    for (let i = 0; i < 5; i++) {
      await seedBelief({
        subject: `s${i}`,
        attribute: "a",
        value: `v${i}`,
        project: paged,
      });
    }
    const page1 = await app.inject({
      method: "GET",
      url: `/projects/${paged}/beliefs?limit=2`,
    });
    expect(page1.statusCode).toBe(200);
    expect((page1.json() as { subject: string }[]).map((r) => r.subject)).toEqual(["s0", "s1"]);
    const page3 = await app.inject({
      method: "GET",
      url: `/projects/${paged}/beliefs?limit=2&offset=4`,
    });
    expect((page3.json() as { subject: string }[]).map((r) => r.subject)).toEqual(["s4"]);
    // 上限：limit 超过 1000 → 400
    const tooBig = await app.inject({
      method: "GET",
      url: `/projects/${paged}/beliefs?limit=5000`,
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it("软删除：active → deleted，列表状态联动", async () => {
    const target = await seedBelief({ subject: "tmp", attribute: "orm", value: "Drizzle" });
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/beliefs/${target.id}/delete`,
    });
    expect(res.statusCode).toBe(200);
    const rows = await t.sql`select status from beliefs where id = ${target.id}`;
    expect(rows[0]!.status).toBe("deleted");
    // 默认列表不再出现，deleted 列表出现
    const active = await app.inject({ method: "GET", url: `/projects/${projectId}/beliefs` });
    expect((active.json() as { id: string }[]).map((r) => r.id)).not.toContain(target.id);
    const deleted = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs?status=deleted`,
    });
    expect((deleted.json() as { id: string }[]).map((r) => r.id)).toContain(target.id);
  });

  it("软删除：非 active 不可删（409），不存在 404", async () => {
    const again = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/beliefs/${deletedBeliefId}/delete`,
    });
    expect(again.statusCode).toBe(409);
    const missing = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/beliefs/${uuidv7()}/delete`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("软删除/恢复：跨项目操作 → 404", async () => {
    const del = await app.inject({
      method: "POST",
      url: `/projects/${otherProjectId}/beliefs/${beliefId}/delete`,
    });
    expect(del.statusCode).toBe(404);
    const res = await app.inject({
      method: "POST",
      url: `/projects/${otherProjectId}/beliefs/${deletedBeliefId}/restore`,
    });
    expect(res.statusCode).toBe(404);
    // 未被实际操作：状态保持原样
    const rows = await t.sql`select status from beliefs where id = ${beliefId}`;
    expect(rows[0]!.status).toBe("active");
  });

  it("恢复：deleted → active，非 deleted 不可恢复（409）", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/beliefs/${deletedBeliefId}/restore`,
    });
    expect(res.statusCode).toBe(200);
    const rows = await t.sql`select status from beliefs where id = ${deletedBeliefId}`;
    expect(rows[0]!.status).toBe("active");
    const conflict = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/beliefs/${deletedBeliefId}/restore`,
    });
    expect(conflict.statusCode).toBe(409);
    const missing = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/beliefs/${uuidv7()}/restore`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
