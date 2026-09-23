import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { beliefVersions, beliefs, observations } from "../src/db/schema.js";
import {
  resolveObservation,
  RESOLVER_VERSION,
  STRENGTHEN_BOOST,
  WEAKEN_PENALTY,
  type BeliefRow,
  type ObservationRow,
} from "../src/resolver/resolver.js";
import type { IntentPolicy } from "../src/resolver/intent-policy.js";
import type { ResolutionTraceRecord, ResolutionTraceWriter } from "../src/resolver/types.js";
import { setupTestDb, type TestDb } from "./db-helper.js";

/**
 * Resolver 编排落库集成测试（#5）。
 * 权威值沿用 #3 映射：USER_EXPLICIT=60 / AGENT_INFERENCE=10。
 */
describe("Resolver 编排与落库（#5）", () => {
  let t: TestDb;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'resolver')`;
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
    value: unknown;
    authority: number;
    validTime?: string | null;
    intent?: string;
    subject?: string;
  }): Promise<ObservationRow> => {
    const subject = opts.subject ?? `subj-${(seq += 1)}`;
    const [row] = await t.db
      .insert(observations)
      .values({
        id: uuidv7(),
        projectId,
        type: "decision",
        subject,
        attribute: "db",
        value: opts.value,
        assertionIntent: (opts.intent ?? "ASSERT") as "ASSERT",
        sourceType: opts.authority >= 60 ? "USER_EXPLICIT" : "AGENT_INFERENCE",
        authority: opts.authority,
        evidenceId: await mkMessage(),
        validTime: opts.validTime ? new Date(opts.validTime) : null,
        confidence: "0.800",
      })
      .returning();
    return row!;
  };

  /** 造一个已有当前版本的 Belief（等价于 #16 创建路径的产物） */
  const seedBelief = async (opts: {
    value: unknown;
    authority: number;
    validFrom: string;
    subject: string;
    confidence?: number;
    isProfile?: boolean;
  }): Promise<BeliefRow> => {
    const obs = await mkObservation({
      value: opts.value,
      authority: opts.authority,
      validTime: opts.validFrom,
      subject: opts.subject,
    });
    const beliefId = uuidv7();
    const versionId = uuidv7();
    await t.db.insert(beliefs).values({
      id: beliefId,
      projectId,
      subject: opts.subject,
      attribute: "db",
      confidence: String(opts.confidence ?? 0.6),
      salience: "0.500",
      importance: "0.800",
      isProfile: opts.isProfile ?? false,
    });
    await t.db.insert(beliefVersions).values({
      id: versionId,
      beliefId,
      value: opts.value,
      validFrom: new Date(opts.validFrom),
      recordedFrom: new Date(),
      sourceObservationId: obs.id,
      resolverVersion: RESOLVER_VERSION,
      confidence: String(opts.confidence ?? 0.6),
    });
    const [row] = await t.db
      .update(beliefs)
      .set({ currentVersionId: versionId })
      .where(eq(beliefs.id, beliefId))
      .returning();
    return row!;
  };

  const collector = () => {
    const records: ResolutionTraceRecord[] = [];
    const writer: ResolutionTraceWriter = { async write(r) { records.push(r); } };
    return { records, writer };
  };

  it("supersede：高权威冲突改判，旧版本双时态关闭、新版本成当前、supersedes 链与 resolver_version 写入", async () => {
    const belief = await seedBelief({
      value: "MySQL", authority: 10, validFrom: "2026-09-01", subject: "sp-1",
    });
    const obs = await mkObservation({ value: "PostgreSQL", authority: 60, validTime: "2026-09-10", subject: "sp-1" });
    const { records, writer } = collector();
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief }, { traceWriter: writer });

    expect(r.relation).toBe("supersede");
    const after = await t.sql`select * from beliefs where id = ${belief.id}`;
    expect(after[0]!.current_version_id).toBe(r.resultVersionId);
    const oldV = await t.sql`select * from belief_versions where id = ${belief.currentVersionId}`;
    expect(oldV[0]!.recorded_to).not.toBeNull();
    expect(oldV[0]!.valid_to).not.toBeNull();
    const newV = await t.sql`select * from belief_versions where id = ${r.resultVersionId}`;
    expect(newV[0]!.value).toBe("PostgreSQL");
    expect(newV[0]!.supersedes_version_id).toBe(oldV[0]!.id);
    expect(newV[0]!.resolver_version).toBe(RESOLVER_VERSION);
    expect(new Date(newV[0]!.valid_from).getTime()).toBe(new Date("2026-09-10T00:00:00.000Z").getTime());
    expect(records).toHaveLength(1);
    expect(records[0]!.relation).toBe("supersede");
    expect(records[0]!.resolverVersion).toBe(RESOLVER_VERSION);
  });

  it("weaken：低权威冲突不改判——当前值/版本不变，confidence 降、evidence_count 加", async () => {
    const belief = await seedBelief({
      value: "PostgreSQL", authority: 60, validFrom: "2026-09-01", subject: "wk-1", confidence: 0.6,
    });
    const obs = await mkObservation({ value: "MySQL", authority: 10, validTime: "2026-09-10", subject: "wk-1" });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });

    expect(r.relation).toBe("weaken");
    expect(r.resultVersionId).toBeNull();
    const after = await t.sql`select * from beliefs where id = ${belief.id}`;
    expect(after[0]!.current_version_id).toBe(belief.currentVersionId);
    expect(Number(after[0]!.confidence)).toBeCloseTo(0.6 - WEAKEN_PENALTY);
    expect(after[0]!.evidence_count).toBe(2);
  });

  it("strengthen：等价佐证——evidence_count+1、confidence 提升封顶 1、不建版本", async () => {
    const belief = await seedBelief({
      value: "Redis", authority: 60, validFrom: "2026-09-01", subject: "st-1", confidence: 0.95,
    });
    const obs = await mkObservation({ value: " redis ", authority: 60, validTime: "2026-09-05", subject: "st-1" });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });

    expect(r.relation).toBe("strengthen");
    expect(r.resultVersionId).toBeNull();
    const after = await t.sql`select * from beliefs where id = ${belief.id}`;
    expect(Number(after[0]!.confidence)).toBe(1); // 0.95 + 0.1 封顶
    expect(after[0]!.evidence_count).toBe(2);
    expect(Number(after[0]!.confidence)).toBeCloseTo(Math.min(1, 0.95 + STRENGTHEN_BOOST));
  });

  it("extend：新值涵盖旧值——合并值建版本、旧版本关闭、当前切换", async () => {
    const belief = await seedBelief({
      value: "用 React", authority: 60, validFrom: "2026-09-01", subject: "ex-1",
    });
    const obs = await mkObservation({ value: "用 React 和 TypeScript", authority: 60, validTime: "2026-09-08", subject: "ex-1" });
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief });

    expect(r.relation).toBe("extend");
    const newV = await t.sql`select * from belief_versions where id = ${r.resultVersionId}`;
    expect(newV[0]!.value).toBe("用 React 和 TypeScript");
    const after = await t.sql`select * from beliefs where id = ${belief.id}`;
    expect(after[0]!.current_version_id).toBe(r.resultVersionId);
  });

  it("迟到证据：valid_time 早于当前版本且值冲突——不改判当前值，历史版本入链并留痕", async () => {
    const belief = await seedBelief({
      value: "SQLite", authority: 60, validFrom: "2026-09-10", subject: "lt-1",
    });
    const obs = await mkObservation({ value: "PostgreSQL", authority: 60, validTime: "2026-09-01", subject: "lt-1" });
    const { records, writer } = collector();
    const r = await resolveObservation(t.db, { projectId, observation: obs, belief }, { traceWriter: writer });

    expect(r.relation).toBe("weaken");
    const after = await t.sql`select * from beliefs where id = ${belief.id}`;
    expect(after[0]!.current_version_id).toBe(belief.currentVersionId);
    const hist = await t.sql`select * from belief_versions where id = ${r.resultVersionId}`;
    expect(hist).toHaveLength(1);
    expect(new Date(hist[0]!.valid_from).getTime()).toBe(new Date("2026-09-01T00:00:00.000Z").getTime());
    expect(new Date(hist[0]!.valid_to).getTime()).toBe(new Date("2026-09-10T00:00:00.000Z").getTime());
    expect(records[0]!.relation).toBe("weaken");
    expect((records[0]!.policies as { detail: { reason: string } }).detail.reason).toBe("late_evidence");
  });

  it("IntentPolicy 接口可注入 mock 替换：ignore 裁决 → 不落库、trace relation=null", async () => {
    const belief = await seedBelief({
      value: "MySQL", authority: 10, validFrom: "2026-09-01", subject: "ip-1", confidence: 0.6,
    });
    const obs = await mkObservation({ value: "PostgreSQL", authority: 60, validTime: "2026-09-10", subject: "ip-1" });
    const mockPolicy: IntentPolicy = { decide: () => ({ action: "ignore" }) };
    const { records, writer } = collector();
    const r = await resolveObservation(
      t.db, { projectId, observation: obs, belief }, { intentPolicy: mockPolicy, traceWriter: writer },
    );

    expect(r.relation).toBeNull();
    const after = await t.sql`select * from beliefs where id = ${belief.id}`;
    expect(after[0]!.current_version_id).toBe(belief.currentVersionId);
    expect(Number(after[0]!.confidence)).toBeCloseTo(0.6);
    expect(records).toHaveLength(1);
    expect(records[0]!.relation).toBeNull();
  });
});
