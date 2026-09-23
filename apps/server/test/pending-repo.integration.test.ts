import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { writeAuditLog } from "../src/gate/audit.js";
import {
  createPending,
  listPending,
  updatePendingStatus,
} from "../src/gate/pending-repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";

describe("pending_candidates 仓储 + audit_log（#15）", () => {
  let t: TestDb;
  let projectId: string;
  let messageId: string;
  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'gate-test')`;
    const cid = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${projectId})`;
    messageId = uuidv7();
    await t.sql`
      insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${messageId}, ${cid}, 'user', '原始文本', now())
    `;
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  const candidate = { subject: "p", attribute: "db", value: "SQLite" };
  const gateScores = { importance: 0.7, novelty: 1, futureUtility: 0.8, specificity: 0.6, confidence: 0.5 };

  it("PENDING 持久化：创建后重启语义不丢（库中可查），字段齐备", async () => {
    const row = await createPending(t.db, {
      projectId,
      candidate,
      gateScores,
      evidenceId: messageId,
      ttlMs: 7 * 24 * 3600 * 1000,
    });
    expect(row.status).toBe("pending");
    expect(row.candidate).toEqual(candidate);
    expect(row.gateScores).toEqual(gateScores);
    expect(row.ttlExpiresAt.getTime()).toBeGreaterThan(Date.now());

    const raw = await t.sql`select * from pending_candidates where id = ${row.id}`;
    expect(raw).toHaveLength(1);
    expect(raw[0]!.evidence_id).toBe(messageId);
  });

  it("listPending：默认只列 pending 态，按项目过滤", async () => {
    const list = await listPending(t.db, projectId);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((r) => r.status === "pending")).toBe(true);
    const other = await listPending(t.db, uuidv7());
    expect(other).toHaveLength(0);
  });

  it("updatePendingStatus：状态迁移并写 decided_at", async () => {
    const row = await createPending(t.db, {
      projectId,
      candidate,
      gateScores,
      evidenceId: messageId,
      ttlMs: 1000,
    });
    const updated = await updatePendingStatus(t.db, row.id, "rejected");
    expect(updated.status).toBe("rejected");
    expect(updated.decidedAt).not.toBeNull();
    // rejected 后不再出现在默认列表
    const list = await listPending(t.db, projectId);
    expect(list.find((r) => r.id === row.id)).toBeUndefined();
  });

  it("audit_log 写入：含 actor/action/target/decision/meta，时间自动", async () => {
    await writeAuditLog(t.db, {
      actor: "gate",
      action: "redact",
      target: "candidate.value",
      decision: "redacted",
      meta: { pattern: "github_pat" },
    });
    const rows = await t.sql`
      select * from audit_log where actor = 'gate' and action = 'redact'
      order by ts desc limit 1
    `;
    expect(rows[0]!.target).toBe("candidate.value");
    expect(rows[0]!.decision).toBe("redacted");
    expect(rows[0]!.meta).toEqual({ pattern: "github_pat" });
    expect(rows[0]!.ts).toBeTruthy();
  });
});
