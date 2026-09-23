import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { createPending } from "../src/gate/pending-repository.js";
import { expirePending, retryPendingGroup } from "../src/gate/lifecycle.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

const baseCandidate = {
  type: "decision",
  subject: "my-project",
  attribute: "cache",
  value: "Redis",
  valid_time: "2026-09-01",
  time_precision: "DAY",
  time_confidence: 0.95,
  assertion_intent: "ASSERT",
  source_type: "USER_EXPLICIT",
  importance: 0.9,
  confidence: 0.5,
  entities: ["my-project", "Redis"],
  is_profile: true,
  authority: 60,
  reliability: 0.95,
};
const gateScores = { importance: 0.9, novelty: 1, futureUtility: 0.8, specificity: 0.8, confidence: 0.5 };

describe("PENDING 四态生命周期（#15）", () => {
  let t: TestDb;
  let projectId: string;
  let messageId: string;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'lifecycle')`;
    const cid = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${projectId})`;
    messageId = uuidv7();
    await t.sql`
      insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${messageId}, ${cid}, 'user', '原始文本', now())
    `;
    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  const mkPending = async (ttlMs = 7 * 24 * 3600 * 1000) =>
    createPending(t.db, {
      projectId,
      candidate: baseCandidate,
      gateScores,
      evidenceId: messageId,
      ttlMs,
    });

  it("retry：同组新证据到来后重估，佐证提升置信 → promoted", async () => {
    const row = await mkPending();
    const promoted = await retryPendingGroup(t.db, projectId, "my-project", "cache");
    expect(promoted.map((p) => p.id)).toContain(row.id);
    const after = await t.sql`select status from pending_candidates where id = ${row.id}`;
    expect(after[0]!.status).toBe("promoted");
  });

  it("retry：不同 subject/attribute 的 PENDING 不受影响，保持 pending", async () => {
    const other = await createPending(t.db, {
      projectId,
      candidate: { ...baseCandidate, subject: "other-project", attribute: "orm" },
      gateScores,
      evidenceId: messageId,
      ttlMs: 7 * 24 * 3600 * 1000,
    });
    const promoted = await retryPendingGroup(t.db, projectId, "my-project", "cache");
    expect(promoted.map((p) => p.id)).not.toContain(other.id);
    const after = await t.sql`select status from pending_candidates where id = ${other.id}`;
    expect(after[0]!.status).toBe("pending");
  });

  it("expire：TTL 过期 → expired", async () => {
    const row = await mkPending(-1000); // 已过期
    const expired = await expirePending(t.db);
    expect(expired).toContain(row.id);
    const after = await t.sql`select status from pending_candidates where id = ${row.id}`;
    expect(after[0]!.status).toBe("expired");
  });

  it("confirm：API 人工确认 → confirmed，且不再出现在待确认列表", async () => {
    const row = await mkPending();
    const res = await app.inject({ method: "POST", url: `/pending/${row.id}/confirm` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("confirmed");
    const list = await app.inject({ method: "GET", url: `/pending?project_id=${projectId}` });
    expect(list.json().find((p: { id: string }) => p.id === row.id)).toBeUndefined();
  });

  it("reject：API 明确拒绝 → rejected", async () => {
    const row = await mkPending();
    const res = await app.inject({ method: "POST", url: `/pending/${row.id}/reject` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
  });

  it("GET /pending：待确认列表可按项目查询", async () => {
    const row = await mkPending();
    const res = await app.inject({ method: "GET", url: `/pending?project_id=${projectId}` });
    expect(res.statusCode).toBe(200);
    const found = res.json().find((p: { id: string }) => p.id === row.id);
    expect(found).toBeDefined();
    expect(found.status).toBe("pending");
  });

  it("不存在的 id：confirm/reject 返回 404 problem+json", async () => {
    const res = await app.inject({ method: "POST", url: `/pending/${uuidv7()}/confirm` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
  });
});
