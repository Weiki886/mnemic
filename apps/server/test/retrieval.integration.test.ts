import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { indexBeliefVersion } from "../src/retrieval/embed.js";
import { retrieve } from "../src/retrieval/search.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";

describe("两路混合检索（#6）", () => {
  let t: TestDb;
  let projectId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "bag-embed",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-fake-offline-0000",
      models: { embedding: "bag-1024" },
    });
    projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'retrieval')`;
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  /** 直接造 belief+version（可选带 embedding 索引），绕开 ingest 以隔离检索侧 */
  const seedFact = async (opts: { subject: string; attribute: string; value: string; indexed: boolean }) => {
    const beliefId = uuidv7();
    const versionId = uuidv7();
    await t.sql`insert into beliefs (id, project_id, subject, attribute, salience)
      values (${beliefId}, ${projectId}, ${opts.subject}, ${opts.attribute}, 0.5)`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from)
      values (${versionId}, ${beliefId}, ${JSON.stringify(opts.value)}, now(), now())`;
    await t.sql`update beliefs set current_version_id = ${versionId} where id = ${beliefId}`;
    if (opts.indexed) {
      await indexBeliefVersion(t.db, TEST_MASTER_KEY, {
        beliefVersionId: versionId, subject: opts.subject, attribute: opts.attribute, value: opts.value,
      }, { factory: bagEmbeddingFactory });
    }
    return { beliefId, versionId };
  };

  const opts = { factory: bagEmbeddingFactory };

  it("语义向量路召回：关键词 AND 不命中时，词袋重叠的事实仍被向量路命中", async () => {
    await seedFact({ subject: `sem-${uuidv7().slice(0, 8)}`, attribute: "db", value: "database choice is PostgreSQL", indexed: true });
    // 词袋 fake 的相似度天然低于真实模型，阈值放宽以聚焦"两路融合逻辑"（阈值本身有专项用例）
    const r = await retrieve(t.db, TEST_MASTER_KEY, projectId, "PostgreSQL storage", { ...opts, threshold: 0.1 });
    expect(r.abstained).toBe(false);
    expect(r.candidates.length).toBeGreaterThan(0);
    const hit = r.candidates.find((c) => c.value === "database choice is PostgreSQL");
    expect(hit).toBeDefined();
    expect(hit!.vectorScore).not.toBeNull();
    expect(hit!.keywordScore).toBeNull(); // "PostgreSQL storage" AND 语义不命中关键词路
  });

  it("关键词路召回：无 embedding 索引的事实也能被 tsvector 命中", async () => {
    await seedFact({ subject: `kw-${uuidv7().slice(0, 8)}`, attribute: "db", value: "数据库改用 PostgreSQL", indexed: false });
    const r = await retrieve(t.db, TEST_MASTER_KEY, projectId, "PostgreSQL", { ...opts, threshold: 0.1 });
    const hit = r.candidates.find((c) => c.value === "数据库改用 PostgreSQL");
    expect(hit).toBeDefined();
    expect(hit!.keywordScore).not.toBeNull();
    expect(hit!.vectorScore).toBeNull(); // 未索引，向量路无分
  });

  it("库中无答案的查询 → 拒答标记且候选为空", async () => {
    const r = await retrieve(t.db, TEST_MASTER_KEY, projectId, "zzzqqq nonexistent", opts);
    expect(r.abstained).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("每次检索 trace 落库：查询/候选 ID/各路得分/融合分/入选与原因", async () => {
    await seedFact({ subject: `trace-${uuidv7().slice(0, 8)}`, attribute: "cache", value: "Redis for cache", indexed: true });
    const r = await retrieve(t.db, TEST_MASTER_KEY, projectId, "Redis cache", opts);
    const rows = await t.sql`select * from retrieval_traces where id = ${r.traceId}`;
    expect(rows).toHaveLength(1);
    const tr = rows[0]!;
    expect(tr.query_text).toBe("Redis cache");
    expect(tr.abstained).toBe(false);
    expect(tr.reinforce_enabled).toBe(false);
    const candidates = tr.candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    const c0 = candidates[0]!;
    expect(c0.beliefVersionId).toBeTruthy();
    expect(typeof c0.fusedScore).toBe("number");
    expect("vectorScore" in c0 && "keywordScore" in c0).toBe(true);
    expect(typeof c0.selected).toBe("boolean");
    expect(typeof c0.reason).toBe("string");
    // 只存 ID 不存内容快照
    expect("value" in c0).toBe(false);
  });

  it("Top-K 入选/落选：超出 K 的候选 reason=below_topk", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedFact({ subject: `bulk-${uuidv7().slice(0, 8)}`, attribute: `attr${i}`, value: `bulk item common token ${i}`, indexed: true });
    }
    const r = await retrieve(t.db, TEST_MASTER_KEY, projectId, "bulk common token", { ...opts, topK: 2 });
    const rows = await t.sql`select candidates from retrieval_traces where id = ${r.traceId}`;
    const candidates = rows[0]!.candidates as Array<{ selected: boolean; reason: string }>;
    const selected = candidates.filter((c) => c.selected);
    const rejected = candidates.filter((c) => !c.selected);
    expect(selected.length).toBeLessThanOrEqual(2);
    expect(rejected.every((c) => c.reason === "below_topk")).toBe(true);
  });

  it("最高融合分低于阈值 → 拒答，trace 中候选 reason=below_threshold", async () => {
    await seedFact({ subject: `weak-${uuidv7().slice(0, 8)}`, attribute: "misc", value: "alpha beta gamma", indexed: true });
    const r = await retrieve(t.db, TEST_MASTER_KEY, projectId, "alpha", { ...opts, threshold: 0.99 });
    expect(r.abstained).toBe(true);
    expect(r.candidates).toHaveLength(0);
    const rows = await t.sql`select candidates, abstained from retrieval_traces where id = ${r.traceId}`;
    expect(rows[0]!.abstained).toBe(true);
    const candidates = rows[0]!.candidates as Array<{ reason: string }>;
    expect(candidates.every((c) => c.reason === "below_threshold")).toBe(true);
  });
});
