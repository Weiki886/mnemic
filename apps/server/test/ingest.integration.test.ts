import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { CandidateWithAuthority } from "../src/extraction/authority.js";
import { ingestCandidate } from "../src/ingest/ingest.js";
import { setupTestDb, type TestDb } from "./db-helper.js";

describe("写入路径③：去重与四路分流（#16）", () => {
  let t: TestDb;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'ingest')`;
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
    subject: `proj-${(seq += 1)}`,
    attribute: "db",
    value: "PostgreSQL",
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

  it("无关候选 → created：建 Belief + 首版本，current_version_id 指向，valid_from 取 valid_time", async () => {
    const r = await ingestCandidate(t.db, projectId, mkCandidate(), await mkMessage());
    expect(r.route).toBe("created");
    const beliefsRows = await t.sql`select * from beliefs where id = ${r.beliefId}`;
    expect(beliefsRows).toHaveLength(1);
    expect(beliefsRows[0]!.current_version_id).not.toBeNull();
    expect(beliefsRows[0]!.evidence_count).toBe(1);
    const v = await t.sql`select * from belief_versions where id = ${beliefsRows[0]!.current_version_id}`;
    expect(v[0]!.value).toBe("PostgreSQL");
    expect(new Date(v[0]!.valid_from).getTime()).toBe(new Date("2026-09-01T00:00:00.000Z").getTime());
    expect(v[0]!.source_observation_id).toBe(r.observationId);
  });

  it("规范化生效：' DB' / 'db ' / 别名 postgres↔postgresql 命中同一 Belief 而非新建", async () => {
    const subject = `norm-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject, attribute: " DB", value: "PostgreSQL" }), await mkMessage());
    expect(first.route).toBe("created");
    // attribute 大小写/空白差异 → 同一 Belief（conflict 而非 created）
    const second = await ingestCandidate(t.db, projectId, mkCandidate({ subject, attribute: "db ", value: "MySQL" }), await mkMessage());
    expect(second.route).toBe("conflict");
    expect(second.beliefId).toBe(first.beliefId);
    // 别名差异（值里不算，subject 里算）：postgres vs postgresql
    const s2 = `alias-${uuidv7().slice(0, 8)}`;
    const a = await ingestCandidate(t.db, projectId, mkCandidate({ subject: s2, attribute: "postgres", value: "v17" }), await mkMessage());
    const b = await ingestCandidate(t.db, projectId, mkCandidate({ subject: s2, attribute: "PostgreSQL", value: "v18" }), await mkMessage());
    expect(b.beliefId).toBe(a.beliefId);
    const count = await t.sql`select count(*)::int as c from beliefs where project_id = ${projectId} and subject = ${s2}`;
    expect(count[0]!.c).toBe(1);
  });

  it("重复投递（同 evidence + 同 subject/attribute）→ skipped，Observation 不重复落库", async () => {
    const evidenceId = await mkMessage();
    const candidate = mkCandidate();
    const first = await ingestCandidate(t.db, projectId, candidate, evidenceId);
    const second = await ingestCandidate(t.db, projectId, candidate, evidenceId);
    expect(second.route).toBe("skipped");
    expect(second.observationId).toBe(first.observationId);
    const obs = await t.sql`select count(*)::int as c from observations where evidence_id = ${evidenceId}`;
    expect(obs[0]!.c).toBe(1);
    const b = await t.sql`select evidence_count from beliefs where id = ${first.beliefId}`;
    expect(b[0]!.evidence_count).toBe(1);
  });

  it("语义等价的重复事实 → merged，evidence_count 增加（经 #5 strengthen）", async () => {
    const subject = `merge-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: "PostgreSQL" }), await mkMessage());
    const second = await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: " postgresql " }), await mkMessage());
    expect(second.route).toBe("merged");
    expect(second.relation).toBe("strengthen");
    const b = await t.sql`select evidence_count from beliefs where id = ${first.beliefId}`;
    expect(b[0]!.evidence_count).toBe(2);
  });

  it("同 subject+attribute 不同值 → conflict 转入 #5，绝不合并（值被改判而非混存）", async () => {
    const subject = `conf-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject, value: "MySQL", valid_time: "2026-09-01" }), await mkMessage());
    const second = await ingestCandidate(t.db, projectId, mkCandidate({ subject, assertion_intent: "UPDATE", value: "PostgreSQL", valid_time: "2026-09-10" }), await mkMessage());
    expect(second.route).toBe("conflict");
    expect(second.relation).toBe("supersede");
    const b = await t.sql`select current_version_id from beliefs where id = ${first.beliefId}`;
    const v = await t.sql`select value from belief_versions where id = ${b[0]!.current_version_id}`;
    expect(v[0]!.value).toBe("PostgreSQL"); // 改判为唯一当前值，不是两值并存
  });

  it("候选涵盖当前值 → conflict 路由桶，Resolver 输出 extend（新版本为合并值）", async () => {
    const subject = `ext-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject, attribute: "frontend", value: "用 React" }), await mkMessage());
    const second = await ingestCandidate(t.db, projectId, mkCandidate({ subject, attribute: "frontend", value: "用 React 和 TypeScript", valid_time: "2026-09-10" }), await mkMessage());
    expect(second.route).toBe("conflict"); // 四路定义不含 extend 独立路由，归 conflict 桶
    expect(second.relation).toBe("extend");
    const b = await t.sql`select current_version_id from beliefs where id = ${first.beliefId}`;
    const v = await t.sql`select value from belief_versions where id = ${b[0]!.current_version_id}`;
    expect(v[0]!.value).toBe("用 React 和 TypeScript");
  });

  it("画像类 Belief 创建 → profile_dirty 置位，is_profile 从候选正确复制入行", async () => {
    const r = await ingestCandidate(t.db, projectId, mkCandidate({ is_profile: true }), await mkMessage());
    const b = await t.sql`select is_profile, profile_dirty from beliefs where id = ${r.beliefId}`;
    expect(b[0]!.is_profile).toBe(true);
    expect(b[0]!.profile_dirty).toBe(true);
  });

  it("非画像创建 → is_profile 与 profile_dirty 均为 false", async () => {
    const r = await ingestCandidate(t.db, projectId, mkCandidate({ is_profile: false }), await mkMessage());
    const b = await t.sql`select is_profile, profile_dirty from beliefs where id = ${r.beliefId}`;
    expect(b[0]!.is_profile).toBe(false);
    expect(b[0]!.profile_dirty).toBe(false);
  });
});
