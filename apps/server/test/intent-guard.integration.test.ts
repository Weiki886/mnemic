import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { resolveObservation, RESOLVER_VERSION, type BeliefRow, type ObservationRow } from "../src/resolver/resolver.js";
import type { ResolutionTraceRecord, ResolutionTraceWriter } from "../src/resolver/types.js";
import { beliefVersions, beliefs, observations } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDb } from "./db-helper.js";

/** 人工修正保护集成测试（#17）：AssertionIntentPolicy 已是 Resolver 默认策略 */
describe("人工修正保护（#17，决策 7）", () => {
  let t: TestDb;
  let projectId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'intent-guard')`;
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

  const mkObservation = async (opts: {
    subject: string;
    value: unknown;
    authority: number;
    sourceType: "USER_CORRECTION" | "USER_EXPLICIT" | "AGENT_INFERENCE";
    intent: "ASSERT" | "UPDATE" | "CORRECT" | "RETRACT";
    validTime: string;
  }): Promise<ObservationRow> => {
    const [row] = await t.db.insert(observations).values({
      id: uuidv7(),
      projectId,
      type: "decision",
      subject: opts.subject,
      attribute: "db",
      value: opts.value,
      assertionIntent: opts.intent,
      sourceType: opts.sourceType,
      authority: opts.authority,
      evidenceId: await mkMessage(),
      validTime: new Date(opts.validTime),
      confidence: "0.900",
    }).returning();
    return row!;
  };

  const seedBelief = async (opts: {
    subject: string;
    value: unknown;
    authority: number;
    sourceType: "USER_CORRECTION" | "USER_EXPLICIT" | "AGENT_INFERENCE";
    validFrom: string;
  }): Promise<BeliefRow> => {
    const obs = await mkObservation({
      subject: opts.subject, value: opts.value, authority: opts.authority,
      sourceType: opts.sourceType, intent: opts.sourceType === "USER_CORRECTION" ? "CORRECT" : "ASSERT",
      validTime: opts.validFrom,
    });
    const beliefId = uuidv7();
    const versionId = uuidv7();
    await t.db.insert(beliefs).values({
      id: beliefId, projectId, subject: opts.subject, attribute: "db",
      confidence: "0.700", salience: "0.500", importance: "0.800",
    });
    await t.db.insert(beliefVersions).values({
      id: versionId, beliefId, value: opts.value,
      validFrom: new Date(opts.validFrom), recordedFrom: new Date(),
      sourceObservationId: obs.id, resolverVersion: RESOLVER_VERSION, confidence: "0.700",
    });
    const [row] = await t.db.update(beliefs).set({ currentVersionId: versionId }).where(eq(beliefs.id, beliefId)).returning();
    return row!;
  };

  it("人工修正后，普通自动提取（ASSERT + AGENT_INFERENCE）不可覆盖", async () => {
    const belief = await seedBelief({
      subject: "guard-1", value: "PostgreSQL", authority: 70, sourceType: "USER_CORRECTION", validFrom: "2026-09-10",
    });
    const obs = await mkObservation({
      subject: "guard-1", value: "MySQL", authority: 10, sourceType: "AGENT_INFERENCE", intent: "ASSERT", validTime: "2026-09-11",
    });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });
    expect(r.relation).toBeNull(); // 意图层拦截，连 weaken 都不发生
    const after = await t.db.select().from(beliefs).where(eq(beliefs.id, belief.id));
    expect(after[0]!.currentVersionId).toBe(belief.currentVersionId);
  });

  it("用户普通提及旧值（ASSERT + 同权威 + 冲突）不触发覆盖", async () => {
    const belief = await seedBelief({
      subject: "guard-2", value: "PostgreSQL", authority: 60, sourceType: "USER_EXPLICIT", validFrom: "2026-09-10",
    });
    const obs = await mkObservation({
      subject: "guard-2", value: "MySQL", authority: 60, sourceType: "USER_EXPLICIT", intent: "ASSERT", validTime: "2026-09-12",
    });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });
    expect(r.relation).toBeNull();
    const after = await t.db.select().from(beliefs).where(eq(beliefs.id, belief.id));
    expect(after[0]!.currentVersionId).toBe(belief.currentVersionId);
  });

  it("新的 UPDATE 可覆盖旧人工修正（同权威新者优先）并保留历史版本", async () => {
    const belief = await seedBelief({
      subject: "guard-3", value: "PostgreSQL", authority: 70, sourceType: "USER_CORRECTION", validFrom: "2026-09-10",
    });
    const obs = await mkObservation({
      subject: "guard-3", value: "SQLite", authority: 70, sourceType: "USER_CORRECTION", intent: "UPDATE", validTime: "2026-09-15",
    });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });
    expect(r.relation).toBe("supersede");
    const versions = await t.db.select().from(beliefVersions).where(eq(beliefVersions.beliefId, belief.id));
    expect(versions).toHaveLength(2); // 旧人工修正作为历史保留
    const oldV = versions.find((v) => v.id === belief.currentVersionId)!;
    expect(oldV.recordedTo).not.toBeNull();
  });

  it("端到端联调：用户明确 UPDATE 换 PostgreSQL 胜过 Agent 推测 MySQL（#5 移交用例）", async () => {
    const belief = await seedBelief({
      subject: "guard-4", value: "MySQL", authority: 10, sourceType: "AGENT_INFERENCE", validFrom: "2026-09-01",
    });
    const obs = await mkObservation({
      subject: "guard-4", value: "PostgreSQL", authority: 60, sourceType: "USER_EXPLICIT", intent: "UPDATE", validTime: "2026-09-10",
    });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });
    expect(r.relation).toBe("supersede");
  });

  it("RETRACT（用户系）→ 信念失效留痕：status=retracted、当前版本区间关闭、可查证", async () => {
    const belief = await seedBelief({
      subject: "guard-5", value: "PostgreSQL", authority: 60, sourceType: "USER_EXPLICIT", validFrom: "2026-09-10",
    });
    const obs = await mkObservation({
      subject: "guard-5", value: "PostgreSQL", authority: 60, sourceType: "USER_EXPLICIT", intent: "RETRACT", validTime: "2026-09-12",
    });
    const records: ResolutionTraceRecord[] = [];
    const writer: ResolutionTraceWriter = { async write(r) { records.push(r); } };
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief }, { traceWriter: writer });

    expect(r.relation).toBeNull();
    const after = await t.db.select().from(beliefs).where(eq(beliefs.id, belief.id));
    expect(after[0]!.status).toBe("retracted");
    expect(after[0]!.currentVersionId).toBeNull();
    const oldV = await t.db.select().from(beliefVersions).where(eq(beliefVersions.id, belief.currentVersionId!));
    expect(oldV[0]!.recordedTo).not.toBeNull();
    expect(oldV[0]!.validTo).not.toBeNull();
    // 可查证：版本链完整保留 + trace 记录 retract 动作
    expect(oldV).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect((records[0]!.policies as { intent: { action: string } }).intent.action).toBe("retract");
  });

  it("RETRACT（非用户系）→ ignore，信念不变", async () => {
    const belief = await seedBelief({
      subject: "guard-6", value: "PostgreSQL", authority: 60, sourceType: "USER_EXPLICIT", validFrom: "2026-09-10",
    });
    const obs = await mkObservation({
      subject: "guard-6", value: "PostgreSQL", authority: 10, sourceType: "AGENT_INFERENCE", intent: "RETRACT", validTime: "2026-09-12",
    });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });
    expect(r.relation).toBeNull();
    const after = await t.db.select().from(beliefs).where(eq(beliefs.id, belief.id));
    expect(after[0]!.status).toBe("active");
    expect(after[0]!.currentVersionId).toBe(belief.currentVersionId);
  });
});
