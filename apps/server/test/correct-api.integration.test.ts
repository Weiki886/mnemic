import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

describe("人工修正入口 API（#17）", () => {
  let t: TestDb;
  let projectId: string;
  let beliefId: string;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'correct-api')`;
    const cid = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${projectId})`;
    const mid = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${mid}, ${cid}, 'user', '原始文本', now())`;
    const obsId = uuidv7();
    await t.sql`insert into observations
      (id, project_id, type, subject, attribute, value, assertion_intent, source_type, authority, evidence_id, valid_time)
      values (${obsId}, ${projectId}, 'decision', 'my-project', 'db', ${JSON.stringify('MySQL')}, 'ASSERT', 'AGENT_INFERENCE', 10, ${mid}, '2026-09-01')`;
    beliefId = uuidv7();
    const versionId = uuidv7();
    await t.sql`insert into beliefs (id, project_id, subject, attribute, confidence, salience, importance)
      values (${beliefId}, ${projectId}, 'my-project', 'db', 0.5, 0.5, 0.8)`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from, source_observation_id)
      values (${versionId}, ${beliefId}, ${JSON.stringify('MySQL')}, '2026-09-01', now(), ${obsId})`;
    await t.sql`update beliefs set current_version_id = ${versionId} where id = ${beliefId}`;
    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it("POST /beliefs/:id/correct → USER_CORRECTION(70) 版本成当前，历史保留，provenance 锚到修正会话", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/beliefs/${beliefId}/correct`,
      payload: { value: "PostgreSQL" },
    });
    expect(res.statusCode).toBe(200);
    const b = await t.sql`select current_version_id from beliefs where id = ${beliefId}`;
    const v = await t.sql`select * from belief_versions where id = ${b[0]!.current_version_id}`;
    expect(v[0]!.value).toBe("PostgreSQL");
    const o = await t.sql`select * from observations where id = ${v[0]!.source_observation_id}`;
    expect(o[0]!.source_type).toBe("USER_CORRECTION");
    expect(o[0]!.authority).toBe(70);
    expect(o[0]!.assertion_intent).toBe("CORRECT");
    const versions = await t.sql`select count(*)::int as c from belief_versions where belief_id = ${beliefId}`;
    expect(versions[0]!.c).toBe(2); // 旧版本作为历史保留
    // provenance：修正证据锚到 manual-corrections 会话的 user 消息
    const m = await t.sql`select m.speaker from messages m where m.id = ${o[0]!.evidence_id}`;
    expect(m[0]!.speaker).toBe("user");
  });

  it("修正后普通自动提取不可覆盖（链路闭环：API → Resolver 意图保护）", async () => {
    // 沿用上一条修正结果：当前 PostgreSQL（USER_CORRECTION 70）
    const cid = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${projectId})`;
    const mid = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${mid}, ${cid}, 'assistant', 'agent 推测', now())`;
    const { ingestCandidate } = await import("../src/ingest/ingest.js");
    await ingestCandidate(t.db, projectId, {
      type: "decision", subject: "my-project", attribute: "db", value: "MySQL",
      valid_time: "2026-09-20", time_precision: "DAY", time_confidence: 0.9,
      assertion_intent: "ASSERT", source_type: "AGENT_INFERENCE",
      importance: 0.8, confidence: 0.8, entities: [], is_profile: false,
      authority: 10, reliability: 0.4,
    }, mid);
    const b = await t.sql`select current_version_id from beliefs where id = ${beliefId}`;
    const v = await t.sql`select value from belief_versions where id = ${b[0]!.current_version_id}`;
    expect(v[0]!.value).toBe("PostgreSQL"); // 未被覆盖
  });

  it("RETRACT 后修正 → 信念复活为 active 且当前值为修正值", async () => {
    // 先 RETRACT（用户系）
    const cid = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${projectId})`;
    const mid = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${mid}, ${cid}, 'user', '撤回', now())`;
    const { ingestCandidate } = await import("../src/ingest/ingest.js");
    await ingestCandidate(t.db, projectId, {
      type: "decision", subject: "my-project", attribute: "db", value: "PostgreSQL",
      valid_time: "2026-09-21", time_precision: "DAY", time_confidence: 1,
      assertion_intent: "RETRACT", source_type: "USER_EXPLICIT",
      importance: 0.8, confidence: 1, entities: [], is_profile: false,
      authority: 60, reliability: 0.95,
    }, mid);
    let b = await t.sql`select status from beliefs where id = ${beliefId}`;
    expect(b[0]!.status).toBe("retracted");
    // 再修正 → 复活
    const res = await app.inject({ method: "POST", url: `/beliefs/${beliefId}/correct`, payload: { value: "SQLite" } });
    expect(res.statusCode).toBe(200);
    b = await t.sql`select status, current_version_id from beliefs where id = ${beliefId}`;
    expect(b[0]!.status).toBe("active");
    const v = await t.sql`select value from belief_versions where id = ${b[0]!.current_version_id}`;
    expect(v[0]!.value).toBe("SQLite");
  });

  it("belief 不存在 → 404 problem+json", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/beliefs/${uuidv7()}/correct`,
      payload: { value: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("value 为空 → 400 problem+json", async () => {
    const res = await app.inject({ method: "POST", url: `/beliefs/${beliefId}/correct`, payload: { value: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});
