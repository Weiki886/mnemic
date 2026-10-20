import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

describe("项目范围内的信念修正与消解历史（#65）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    otherProjectId = uuidv7();
    await t.sql`insert into projects (id, name) values
      (${projectId}, 'belief-actions-scope'), (${otherProjectId}, 'other-scope')`;
    app = buildApp({ auth: false, db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  async function seedBelief(owner = projectId) {
    const conversationId = uuidv7();
    const messageId = uuidv7();
    const observationId = uuidv7();
    const beliefId = uuidv7();
    const versionId = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${conversationId}, ${owner})`;
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${messageId}, ${conversationId}, 'user', '初始事实', now())`;
    await t.sql`insert into observations
      (id, project_id, type, subject, attribute, value, assertion_intent, source_type, authority, evidence_id, valid_time)
      values (${observationId}, ${owner}, 'fact', ${`scope-${beliefId}`}, 'db', '"MySQL"',
        'ASSERT', 'USER_EXPLICIT', 60, ${messageId}, '2026-09-01')`;
    await t.sql`insert into beliefs (id, project_id, subject, attribute, confidence, importance)
      values (${beliefId}, ${owner}, ${`scope-${beliefId}`}, 'db', 0.8, 0.8)`;
    await t.sql`insert into belief_versions
      (id, belief_id, value, valid_from, recorded_from, source_observation_id)
      values (${versionId}, ${beliefId}, '"MySQL"', '2026-09-01', now(), ${observationId})`;
    await t.sql`update beliefs set current_version_id = ${versionId} where id = ${beliefId}`;
    return { beliefId, versionId, observationId };
  }

  // 拒绝请求不仅看状态码：比较项目全部正文/版本/轨迹，防止留下修正出处或证据。
  async function snapshot(owner: string) {
    const conversations =
      await t.sql`select * from conversations where project_id = ${owner} order by id`;
    const messages = await t.sql`select m.* from messages m inner join conversations c
      on m.conversation_id = c.id where c.project_id = ${owner} order by m.id`;
    const observations =
      await t.sql`select * from observations where project_id = ${owner} order by id`;
    const beliefs = await t.sql`select * from beliefs where project_id = ${owner} order by id`;
    const versions = await t.sql`select v.* from belief_versions v inner join beliefs b
      on v.belief_id = b.id where b.project_id = ${owner} order by v.id`;
    const traces =
      await t.sql`select * from resolution_traces where project_id = ${owner} order by id`;
    return JSON.stringify({ conversations, messages, observations, beliefs, versions, traces });
  }

  const path = (owner: string, beliefId: string, action: string) =>
    `/projects/${owner}/beliefs/${beliefId}/${action}`;

  it("同项目不同信念并发首次修正只创建一条专用会话，各自出处独立（#70）", async () => {
    const owner = uuidv7();
    await t.sql`insert into projects (id, name) values (${owner}, 'parallel-corrections')`;
    const first = await seedBelief(owner);
    const second = await seedBelief(owner);
    let pending: Promise<{ statusCode: number }[]> | undefined;
    let responses: { statusCode: number }[] | undefined;
    try {
      await t.sql.begin(async (locked) => {
        const [backend] = await locked`select pg_backend_pid() as pid`;
        // 两条请求都能先 SELECT，但 INSERT 需等此锁释放，从而确定性复现先查再建竞态。
        await locked`lock table conversations in share mode`;
        pending = Promise.all(
          [first, second].map(({ beliefId }) =>
            app
              .inject({
                method: "POST",
                url: path(owner, beliefId, "correct"),
                payload: { value: "PostgreSQL" },
              })
              .then((res) => res),
          ),
        );
        let waiting = 0;
        const deadline = Date.now() + 5000;
        while (waiting < 2 && Date.now() < deadline) {
          const [state] = await t.sql`select count(*)::int as waiting from pg_stat_activity
            where ${backend!.pid} = any(pg_blocking_pids(pid))`;
          waiting = state!.waiting;
          if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(2);
      });
    } finally {
      responses = await pending;
    }
    expect(responses?.map((res) => res.statusCode)).toEqual([200, 200]);
    const dedicated =
      await t.sql`select id from conversations where project_id = ${owner} and title = 'manual-corrections'`;
    expect(dedicated).toHaveLength(1);
    const sources =
      await t.sql`select b.id, v.id as version_id, v.value, m.id as message_id, m.conversation_id
      from beliefs b join belief_versions v on b.current_version_id = v.id
      join observations o on v.source_observation_id = o.id join messages m on o.evidence_id = m.id
      where b.project_id = ${owner} order by b.id`;
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((row) => row.message_id)).size).toBe(2);
    expect(new Set(sources.map((row) => row.version_id)).size).toBe(2);
    for (const source of sources) {
      expect(source.conversation_id).toBe(dedicated[0]!.id);
      expect(source.value).toBe("PostgreSQL");
    }
  }, 15_000);

  it("数据库只限制项目专用会话，普通重名会话和不同项目不受影响（#70）", async () => {
    const a = uuidv7();
    const b = uuidv7();
    await t.sql`insert into projects (id, name) values (${a}, 'unique-a'), (${b}, 'unique-b')`;
    await t.sql`insert into conversations (id, project_id, title) values
      (${uuidv7()}, ${a}, 'manual-corrections'), (${uuidv7()}, ${b}, 'manual-corrections'),
      (${uuidv7()}, ${a}, 'same title'), (${uuidv7()}, ${a}, 'same title')`;
    const normal =
      await t.sql`select id from conversations where project_id = ${a} and title = 'same title'`;
    expect(normal).toHaveLength(2);
    await expect(t.sql`insert into conversations (id, project_id, title)
      values (${uuidv7()}, ${a}, 'manual-corrections')`).rejects.toMatchObject({ code: "23505" });
  });

  it("不同项目并行修正各自复用已有专用会话（#70）", async () => {
    const owners = [uuidv7(), uuidv7()];
    const targets = [];
    for (const owner of owners) {
      await t.sql`insert into projects (id, name) values (${owner}, 'separate-corrections')`;
      const conversationId = uuidv7();
      await t.sql`insert into conversations (id, project_id, title)
        values (${conversationId}, ${owner}, 'manual-corrections')`;
      targets.push({ owner, conversationId, ...(await seedBelief(owner)) });
    }
    const results = await Promise.all(
      targets.map((target) =>
        app.inject({
          method: "POST",
          url: path(target.owner, target.beliefId, "correct"),
          payload: { value: "SQLite" },
        }),
      ),
    );
    expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
    for (const target of targets) {
      const [source] = await t.sql`select m.conversation_id, c.project_id from beliefs b
        join belief_versions v on b.current_version_id = v.id
        join observations o on v.source_observation_id = o.id
        join messages m on o.evidence_id = m.id join conversations c on m.conversation_id = c.id
        where b.id = ${target.beliefId}`;
      expect(source).toEqual({ conversation_id: target.conversationId, project_id: target.owner });
      const dedicated = await t.sql`select id from conversations
        where project_id = ${target.owner} and title = 'manual-corrections'`;
      expect(dedicated).toEqual([{ id: target.conversationId }]);
    }
  });

  it("已删除记忆修正 → 409 且无副作用，显式恢复后可修正", async () => {
    const { beliefId } = await seedBelief();
    const deleted = await app.inject({ method: "POST", url: path(projectId, beliefId, "delete") });
    expect(deleted.statusCode).toBe(200);
    const before = await snapshot(projectId);
    const rejected = await app.inject({
      method: "POST",
      url: path(projectId, beliefId, "correct"),
      payload: { value: "PostgreSQL" },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.headers["content-type"]).toContain("application/problem+json");
    expect(rejected.json().code).toBe("CONFLICT");
    expect(await snapshot(projectId)).toBe(before);

    const restored = await app.inject({
      method: "POST",
      url: path(projectId, beliefId, "restore"),
    });
    expect(restored.statusCode).toBe(200);
    const corrected = await app.inject({
      method: "POST",
      url: path(projectId, beliefId, "correct"),
      payload: { value: "PostgreSQL" },
    });
    expect(corrected.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/beliefs/${beliefId}`,
    });
    expect(detail.json()).toMatchObject({ status: "active", current_value: "PostgreSQL" });
  });

  it("删除先持有行锁：等待中的修正不能在删除提交后复活记忆", async () => {
    const { beliefId } = await seedBelief();
    const expected = JSON.parse(await snapshot(projectId));
    expected.beliefs.find((row: { id: string }) => row.id === beliefId).status = "deleted";
    let pending: Promise<{ statusCode: number }> | undefined;
    let response: { statusCode: number } | undefined;
    try {
      await t.sql.begin(async (locked) => {
        const [backend] = await locked`select pg_backend_pid() as pid`;
        await locked`update beliefs set status = 'deleted' where id = ${beliefId}`;
        pending = app
          .inject({
            method: "POST",
            url: path(projectId, beliefId, "correct"),
            payload: { value: "PostgreSQL" },
          })
          .then((res) => res);
        // 等到请求确实被删除事务阻塞，再提交删除；不靠固定 sleep 猜并发顺序。
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (!blocked && Date.now() < deadline) {
          const [state] = await t.sql`select exists (
            select 1 from pg_stat_activity where ${backend!.pid} = any(pg_blocking_pids(pid))
          ) as blocked`;
          blocked = state!.blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      });
    } finally {
      response = await pending;
    }
    expect(response?.statusCode).toBe(409);
    expect(await snapshot(projectId)).toBe(JSON.stringify(expected));
  }, 15_000);

  it("跨项目访问 deleted 记忆仍为 404，不泄露状态", async () => {
    const { beliefId } = await seedBelief(otherProjectId);
    await t.sql`update beliefs set status = 'deleted' where id = ${beliefId}`;
    const before = await snapshot(otherProjectId);
    const res = await app.inject({
      method: "POST",
      url: path(projectId, beliefId, "correct"),
      payload: { value: "new" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
    expect(await snapshot(otherProjectId)).toBe(before);
  });

  it("本项目可修正并读取对应消解历史", async () => {
    const { beliefId } = await seedBelief();
    const corrected = await app.inject({
      method: "POST",
      url: path(projectId, beliefId, "correct"),
      payload: { value: "PostgreSQL" },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({ beliefId, relation: "supersede" });
    const history = await app.inject({
      method: "GET",
      url: path(projectId, beliefId, "resolutions"),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(1);
    expect(history.json()[0]).toMatchObject({ projectId, beliefId, relation: "supersede" });
  });

  it("跨项目修正 → 404，两个项目均无写入副作用", async () => {
    const { beliefId } = await seedBelief(otherProjectId);
    const before = [await snapshot(projectId), await snapshot(otherProjectId)];
    const res = await app.inject({
      method: "POST",
      url: path(projectId, beliefId, "correct"),
      payload: { value: "secret overwritten" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().code).toBe("NOT_FOUND");
    expect([await snapshot(projectId), await snapshot(otherProjectId)]).toEqual(before);
  });

  it("跨项目消解历史 → 404，未知项目和未知信念响应相同", async () => {
    const { beliefId } = await seedBelief(otherProjectId);
    for (const [owner, id] of [
      [projectId, beliefId],
      [uuidv7(), beliefId],
      [projectId, uuidv7()],
    ]) {
      const res = await app.inject({ method: "GET", url: path(owner!, id!, "resolutions") });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.json().code).toBe("NOT_FOUND");
    }
  });

  it("历史查询不信任 trace 上错误的 project_id", async () => {
    const { beliefId, observationId } = await seedBelief();
    await t.sql`insert into resolution_traces
      (id, project_id, belief_id, observation_id, relation, policies, resolver_version)
      values (${uuidv7()}, ${otherProjectId}, ${beliefId}, ${observationId}, 'weaken', '{}', 'test')`;
    const res = await app.inject({ method: "GET", url: path(projectId, beliefId, "resolutions") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it.each(["correct", "resolutions"])(
    "%s 校验 projectId 和 id 的 UUID，返回结构化 400",
    async (action) => {
      const { beliefId } = await seedBelief();
      for (const [owner, id, field] of [
        ["invalid", beliefId, "projectId"],
        [projectId, "invalid", "id"],
      ]) {
        const res = await app.inject({
          method: action === "correct" ? "POST" : "GET",
          url: path(owner!, id!, action),
          ...(action === "correct" ? { payload: { value: "new" } } : {}),
        });
        expect(res.statusCode).toBe(400);
        expect(res.headers["content-type"]).toContain("application/problem+json");
        expect(res.json()).toMatchObject({
          code: "VALIDATION_FAILED",
          errors: expect.arrayContaining([expect.objectContaining({ path: field })]),
        });
      }
    },
  );

  it.each(["correct", "resolutions"])("旧的无项目 %s 路由不再可用", async (action) => {
    const { beliefId } = await seedBelief();
    const before = await snapshot(projectId);
    const res = await app.inject({
      method: action === "correct" ? "POST" : "GET",
      url: `/beliefs/${beliefId}/${action}`,
      ...(action === "correct" ? { payload: { value: "new" } } : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(await snapshot(projectId)).toBe(before);
  });
});
