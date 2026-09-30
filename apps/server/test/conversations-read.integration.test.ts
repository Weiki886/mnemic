import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

/** 对话只读视图 API（#8）：会话列表 + 消息时间线（含回答引用记忆的现查解析） */
describe("对话只读 API（#8）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let projectId: string;
  let otherProject: string;
  let convId: string;
  let beliefId: string;
  let versionId: string;
  let otherVersionId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'conv-read')`;
    otherProject = uuidv7();
    await t.sql`insert into projects (id, name) values (${otherProject}, 'conv-read-other')`;
    await t.sql`insert into conversations (id, project_id, title) values (${uuidv7()}, ${otherProject}, 'other-conv')`;
    // other 项目的信念 + 版本（跨项目引用测试用）
    const otherBeliefId = uuidv7();
    otherVersionId = uuidv7();
    await t.sql`insert into beliefs (id, project_id, subject, attribute) values (${otherBeliefId}, ${otherProject}, 'secret-proj', 'api-key')`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from)
      values (${otherVersionId}, ${otherBeliefId}, ${JSON.stringify("sk-secret")}, '2026-09-01', now())`;

    // 一条信念 + 版本，供助手消息引用
    beliefId = uuidv7();
    versionId = uuidv7();
    await t.sql`insert into beliefs (id, project_id, subject, attribute) values (${beliefId}, ${projectId}, 'my-project', 'database')`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from)
      values (${versionId}, ${beliefId}, ${JSON.stringify("PostgreSQL")}, '2026-09-01', now())`;
    await t.sql`update beliefs set current_version_id = ${versionId} where id = ${beliefId}`;

    convId = uuidv7();
    await t.sql`insert into conversations (id, project_id, title, ended_at)
      values (${convId}, ${projectId}, 'db 讨论', '2026-09-24T10:00:00Z')`;
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${uuidv7()}, ${convId}, 'user', '数据库用什么？', '2026-09-24T09:00:00Z')`;
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time, memories)
      values (${uuidv7()}, ${convId}, 'assistant', '用 PostgreSQL。', '2026-09-24T09:00:05Z', ${JSON.stringify([versionId])})`;
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${uuidv7()}, ${convId}, 'user', '为什么？', '2026-09-24T09:01:00Z')`;
    // 脏数据防御：消息里被塞了其他项目的版本引用（写库 bug / 注入），读出时不得解析
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time, memories)
      values (${uuidv7()}, ${convId}, 'assistant', '引用被污染的回答。', '2026-09-24T09:02:00Z', ${JSON.stringify([otherVersionId])})`;
    // 无消息会话也应在列表中可读
    await t.sql`insert into conversations (id, project_id, title) values (${uuidv7()}, ${projectId}, 'empty-conv')`;

    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it("会话列表：按项目过滤，带消息数与起止时间", async () => {
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/conversations` });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as {
      id: string;
      title: string | null;
      started_at: string;
      ended_at: string | null;
      message_count: number;
    }[];
    expect(rows.length).toBe(2);
    const main = rows.find((r) => r.id === convId)!;
    expect(main.title).toBe("db 讨论");
    expect(main.ended_at).not.toBeNull();
    expect(main.message_count).toBe(4);
    const empty = rows.find((r) => r.title === "empty-conv")!;
    expect(empty.message_count).toBe(0);
  });

  it("会话详情：消息按时间排序，引用记忆现查解析", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/conversations/${convId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      project_id: string;
      messages: {
        id: string;
        speaker: string;
        raw_text: string;
        msg_time: string;
        memories:
          | {
              belief_version_id: string;
              belief_id: string;
              subject: string;
              attribute: string;
              value: unknown;
            }[]
          | null;
      }[];
    };
    expect(body.project_id).toBe(projectId);
    expect(body.messages.length).toBe(4);
    const [m1, m2, m3, m4] = body.messages;
    expect(m1!.speaker).toBe("user");
    expect(m1!.memories).toBeNull();
    expect(m2!.speaker).toBe("assistant");
    expect(m2!.memories).toEqual([
      {
        belief_version_id: versionId,
        belief_id: beliefId,
        subject: "my-project",
        attribute: "database",
        value: "PostgreSQL",
      },
    ]);
    expect(m3!.raw_text).toBe("为什么？");
    // 跨项目引用在读取侧被过滤：join 时重新断言项目边界，不信任 jsonb 内容
    expect(m4!.memories).toEqual([]);
  });

  it("参数校验：非法 UUID → 400", async () => {
    const bad1 = await app.inject({
      method: "GET",
      url: `/projects/not-a-uuid/conversations`,
    });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/conversations/not-a-uuid`,
    });
    expect(bad2.statusCode).toBe(400);
  });

  it("会话列表分页：limit/offset 生效，limit 上限 1000", async () => {
    const page1 = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/conversations?limit=1`,
    });
    expect(page1.statusCode).toBe(200);
    expect((page1.json() as unknown[]).length).toBe(1);
    const page2 = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/conversations?limit=1&offset=1`,
    });
    expect((page2.json() as unknown[]).length).toBe(1);
    expect((page2.json() as { id: string }[])[0]!.id).not.toBe(
      (page1.json() as { id: string }[])[0]!.id,
    );
    const tooBig = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/conversations?limit=5000`,
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it("会话详情：不存在 → 404 problem+json", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/conversations/${uuidv7()}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("会话详情：跨项目访问 → 404（不泄露存在性）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/projects/${otherProject}/conversations/${convId}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});
