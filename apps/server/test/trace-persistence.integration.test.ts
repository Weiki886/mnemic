import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { encrypt } from "../src/providers/crypto.js";
import { ingestCandidate } from "../src/ingest/ingest.js";
import type { CandidateWithAuthority } from "../src/extraction/authority.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

describe("resolution_traces 落库（#18，决策 11）", () => {
  let t: TestDb;
  let projectId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    // model_snapshot 读取全局 provider_configs（与 project 无关）：
    // 本文件需要"无配置 → null"的干净起点，全表清空（singleFork 串行，其他文件 beforeAll 会自建其所需行）
    await t.sql`delete from provider_configs`;
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'trace-persist')`;
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  const mkMessage = async () => {
    const cid = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${projectId})`;
    const mid = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${mid}, ${cid}, 'user', '原始文本', now())`;
    return mid;
  };

  const mkCandidate = (over: Partial<CandidateWithAuthority> = {}): CandidateWithAuthority => ({
    type: "decision",
    subject: `tr-${uuidv7().slice(0, 8)}`,
    attribute: "db",
    value: "MySQL",
    valid_time: "2026-09-01",
    time_precision: "DAY",
    time_confidence: 0.95,
    assertion_intent: "ASSERT",
    source_type: "USER_EXPLICIT",
    importance: 0.8,
    confidence: 0.8,
    entities: [],
    is_profile: false,
    authority: 60,
    reliability: 0.95,
    ...over,
  });

  it("每次消解落一条完整记录（supersede：引用/四态/置信前后/policies/resolver_version）", async () => {
    const subject = `tr-full-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: "MySQL" }), await mkMessage());
    const second = await ingestCandidate(
      t.db, projectId,
      mkCandidate({ subject, value: "PostgreSQL", valid_time: "2026-09-10", assertion_intent: "UPDATE" }),
      await mkMessage(),
    );
    const rows = await t.sql`select * from resolution_traces where belief_id = ${first.beliefId}`;
    expect(rows).toHaveLength(1);
    const tr = rows[0]!;
    expect(tr.observation_id).toBe(second.observationId);
    expect(tr.relation).toBe("supersede");
    expect(tr.previous_version_id).not.toBeNull();
    expect(tr.result_version_id).toBe(second.relation === "supersede" ? tr.result_version_id : null);
    expect(Number(tr.confidence_before)).toBeCloseTo(0.8);
    expect(Number(tr.confidence_after)).toBeCloseTo(0.8);
    expect(tr.policies.detail.reason).toBe("temporal");
    expect(tr.resolver_version).toBeTruthy();
    // 创建（created）不是消解，不应有 trace
    const all = await t.sql`select count(*)::int as c from resolution_traces where belief_id = ${first.beliefId}`;
    expect(all[0]!.c).toBe(1);
  });

  it("strengthen 也落记录（四态中任意一种都算消解）", async () => {
    const subject = `tr-str-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: "Redis" }), await mkMessage());
    await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: "redis" }), await mkMessage());
    const rows = await t.sql`select relation from resolution_traces where belief_id = ${first.beliefId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relation).toBe("strengthen");
  });

  it("表结构无内容快照列（value/raw_text 等正文一律经 FK 回查）", async () => {
    const cols = await t.sql`
      select column_name from information_schema.columns
      where table_name = 'resolution_traces' and table_schema = 'public'`;
    const names = cols.map((c) => c.column_name);
    for (const forbidden of ["value", "raw_text", "content", "snapshot_value"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("model_snapshot：配置 extraction 槽位后含 provider+model；未配置时为 null", async () => {
    // 未配置 → null（前面的用例均未配置 provider，抽查一条）
    const before = await t.sql`select model_snapshot from resolution_traces
      where project_id = ${projectId} order by created_at limit 1`;
    expect(before[0]!.model_snapshot).toBeNull();
    // 配置 extraction 槽位 → 快照含 provider 与 model
    await t.db.insert((await import("../src/db/schema.js")).providerConfigs).values({
      id: uuidv7(),
      name: `trace-test-${uuidv7().slice(0, 8)}`,
      protocol: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKeyEncrypted: encrypt("sk-fake", TEST_MASTER_KEY),
      models: { extraction: "deepseek-flash" },
    });
    const subject = `tr-ms-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: "MySQL" }), await mkMessage());
    await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: "redis" }), await mkMessage());
    const rows = await t.sql`select model_snapshot from resolution_traces where belief_id = ${first.beliefId} order by created_at`;
    expect(rows[0]!.model_snapshot.provider).toContain("trace-test-");
    expect(rows[0]!.model_snapshot.model).toBe("deepseek-flash");
    expect(rows[0]!.model_snapshot.slot).toBe("extraction");
  });
});
