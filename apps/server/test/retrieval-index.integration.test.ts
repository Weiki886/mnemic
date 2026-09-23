import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { indexBeliefVersion } from "../src/retrieval/embed.js";
import { ingestCandidate } from "../src/ingest/ingest.js";
import type { CandidateWithAuthority } from "../src/extraction/authority.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";

describe("写入侧 embedding 索引（#6）", () => {
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
    await t.sql`insert into projects (id, name) values (${projectId}, 'retrieval-index')`;
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
    subject: `ri-${uuidv7().slice(0, 8)}`,
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

  const indexDeps = {
    indexEmbedding: (args: { beliefVersionId: string; subject: string; attribute: string; value: unknown }) =>
      indexBeliefVersion(t.db, TEST_MASTER_KEY, args, { factory: bagEmbeddingFactory }),
  };

  it("indexBeliefVersion：生成 1024 维向量入库，model 记录槽位模型 ID", async () => {
    const versionId = uuidv7();
    const beliefId = uuidv7();
    await t.sql`insert into beliefs (id, project_id, subject, attribute) values (${beliefId}, ${projectId}, 'x', 'y')`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from)
      values (${versionId}, ${beliefId}, ${JSON.stringify("v")}, now(), now())`;
    await indexBeliefVersion(t.db, TEST_MASTER_KEY, {
      beliefVersionId: versionId, subject: "my-project", attribute: "db", value: "PostgreSQL",
    }, { factory: bagEmbeddingFactory });
    const rows = await t.sql`select * from memory_embeddings where belief_version_id = ${versionId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("bag-1024");
    const vec = JSON.parse(rows[0]!.embedding);
    expect(vec).toHaveLength(1024);
  });

  it("ingest 注入 indexEmbedding 后：created 首版本即索引；supersede 新版本也索引", async () => {
    const subject = `ri-auto-${uuidv7().slice(0, 8)}`;
    const first = await ingestCandidate(t.db, projectId, mkCandidate({ subject }), await mkMessage(), indexDeps);
    const v1 = await t.sql`select current_version_id from beliefs where id = ${first.beliefId}`;
    const e1 = await t.sql`select count(*)::int as c from memory_embeddings where belief_version_id = ${v1[0]!.current_version_id}`;
    expect(e1[0]!.c).toBe(1);
    const second = await ingestCandidate(
      t.db, projectId,
      mkCandidate({ subject, value: "SQLite", valid_time: "2026-09-10", assertion_intent: "UPDATE" }),
      await mkMessage(),
      indexDeps,
    );
    expect(second.relation).toBe("supersede");
    const v2 = await t.sql`select current_version_id from beliefs where id = ${first.beliefId}`;
    const e2 = await t.sql`select count(*)::int as c from memory_embeddings where belief_version_id = ${v2[0]!.current_version_id}`;
    expect(e2[0]!.c).toBe(1); // 新版本同样被索引
  });
});
