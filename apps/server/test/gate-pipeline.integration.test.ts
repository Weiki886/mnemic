import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { CandidateWithAuthority } from "../src/extraction/authority.js";
import { processCandidate } from "../src/gate/pipeline.js";
import { setupTestDb, type TestDb } from "./db-helper.js";

describe("Gate 处理管道（脱敏 → 审计 → 判定 → 路由，#15）", () => {
  let t: TestDb;
  let projectId: string;
  let messageId: string;
  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'pipeline')`;
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

  const base: CandidateWithAuthority = {
    type: "decision",
    subject: "my-project",
    attribute: "database",
    value: "SQLite",
    valid_time: "2026-09-01",
    time_precision: "DAY",
    time_confidence: 0.95,
    assertion_intent: "UPDATE",
    source_type: "USER_EXPLICIT",
    importance: 0.9,
    confidence: 0.9,
    entities: ["my-project", "SQLite"],
    is_profile: true,
    authority: 60,
    reliability: 0.95,
  };

  it("含 GitHub token 的候选：value 被 [REDACTED]，脱敏事件入 audit_log，密钥本体全程不出现", async () => {
    const secret = "ghp_T0k3nT0k3nT0k3nT0k3nT0k3n";
    const r = await processCandidate(t.db, projectId, { ...base, value: `token 是 ${secret}` }, messageId);
    expect(JSON.stringify(r)).not.toContain(secret);

    const audits = await t.sql`
      select * from audit_log where action = 'redact' and meta->>'pattern' = 'github_pat'
      order by ts desc limit 1
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decision).toBe("redacted");
    expect(JSON.stringify(audits[0])).not.toContain(secret);

    // 脱敏后 value 含 [REDACTED]；高价值候选仍 WRITE（交给 #16）
    expect(r.decision).toBe("WRITE");
    if (r.decision === "WRITE") {
      expect(r.candidate.value).toContain("[REDACTED]");
    }
  });

  it("PENDING 判定：候选落 pending_candidates 表（已脱敏快照）", async () => {
    const r = await processCandidate(
      t.db,
      projectId,
      { ...base, attribute: "cache", confidence: 0.5 },
      messageId,
    );
    expect(r.decision).toBe("PENDING");
    if (r.decision !== "PENDING") return;
    const rows = await t.sql`select * from pending_candidates where id = ${r.pendingId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect((rows[0]!.candidate as { attribute: string }).attribute).toBe("cache");
    expect(rows[0]!.gate_scores).toMatchObject({ confidence: 0.5 });
  });

  it("SKIP 判定：不落任何表", async () => {
    const r = await processCandidate(
      t.db,
      projectId,
      { ...base, type: "fact", attribute: "chitchat", value: "还行", importance: 0.2, is_profile: false },
      messageId,
    );
    expect(r.decision).toBe("SKIP");
    const rows = await t.sql`
      select * from pending_candidates where candidate->>'attribute' = 'chitchat'
    `;
    expect(rows).toHaveLength(0);
  });
});
