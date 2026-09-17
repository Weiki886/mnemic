/**
 * Spike ②：pgvector 向量检索 + tsvector 全文检索 + 加权混合 链路验证
 * 运行：pnpm --filter @mnemic/spike run spike:pgvector
 * 前置：DATABASE_URL 指向 PG17+pgvector（见 README Quickstart）
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://mnemic:mnemic@localhost:5432/mnemic";
const sql = postgres(url);

const DIM = 8;
const ROWS = 500;
const TOPICS = [
  ["database", "postgresql", "orm", "migration"],
  ["frontend", "vue", "component", "vite"],
  ["deployment", "docker", "caddy", "server"],
  ["memory", "belief", "conflict", "retrieval"],
] as const;

function randomVec(): number[] {
  return Array.from({ length: DIM }, () => Math.random());
}

async function main() {
  const t0 = performance.now();
  // vector 维度是类型修饰符，不能走绑定参数，只能用本地常量拼接
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  await sql.unsafe(`DROP TABLE IF EXISTS spike_docs`);
  await sql.unsafe(`
    CREATE TABLE spike_docs (
      id serial PRIMARY KEY,
      content text NOT NULL,
      embedding vector(${DIM}) NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
    )
  `);

  // 造数据：每条内容围绕一个主题，向量 = 主题质心 + 噪声
  const centroids = TOPICS.map(() => randomVec());
  for (let i = 0; i < ROWS; i++) {
    const t = i % TOPICS.length;
    const words = TOPICS[t]!;
    const content = `note ${i} about ${words[i % words.length]} and ${words[(i + 1) % words.length]}`;
    const vec = centroids[t]!.map((c) => c + (Math.random() - 0.5) * 0.05);
    const vecStr = `[${vec.join(",")}]`;
    await sql`INSERT INTO spike_docs (content, embedding) VALUES (${content}, ${vecStr}::vector)`;
  }

  // HNSW 索引（能力 2.7）
  await sql`CREATE INDEX spike_docs_hnsw ON spike_docs USING hnsw (embedding vector_cosine_ops)`;
  await sql`CREATE INDEX spike_docs_tsv ON spike_docs USING gin (tsv)`;

  // 1) 纯向量检索：用主题 0 质心查询，期望命中主题 0 的行
  const t1 = performance.now();
  const queryVec = `[${centroids[0]!.join(",")}]`;
  const vecHits = await sql<{ id: number; content: string; dist: number }[]>`
    SELECT id, content, embedding <=> ${queryVec}::vector AS dist
    FROM spike_docs ORDER BY embedding <=> ${queryVec}::vector LIMIT 5
  `;
  const vecMs = performance.now() - t1;
  // serial id 从 1 开始：主题 = (id-1) % 主题数
  const vecTopic0 = vecHits.filter((h) => (h.id - 1) % TOPICS.length === 0).length;

  // 2) 纯全文检索
  const t2 = performance.now();
  const ftsHits = await sql<{ id: number; content: string; rank: number }[]>`
    SELECT id, content, ts_rank(tsv, plainto_tsquery('english', 'postgresql')) AS rank
    FROM spike_docs WHERE tsv @@ plainto_tsquery('english', 'postgresql')
    ORDER BY rank DESC LIMIT 5
  `;
  const ftsMs = performance.now() - t2;

  // 3) 混合：向量距离 + 全文 rank 加权融合（纯 SQL）
  const t3 = performance.now();
  const hybrid = await sql<{ id: number; score: number }[]>`
    SELECT id,
           0.7 * (1 - (embedding <=> ${queryVec}::vector)) +
           0.3 * COALESCE(ts_rank(tsv, plainto_tsquery('english', 'database')), 0) AS score
    FROM spike_docs
    ORDER BY score DESC LIMIT 5
  `;
  const hybridMs = performance.now() - t3;

  await sql`DROP TABLE spike_docs`;

  const report = {
    rows: ROWS,
    vectorSearch: { ms: +vecMs.toFixed(1), top5全部命中目标主题: vecTopic0 === 5, hits: vecHits.length },
    fullTextSearch: { ms: +ftsMs.toFixed(1), hits: ftsHits.length },
    hybrid: { ms: +hybridMs.toFixed(1), hits: hybrid.length },
    totalMs: +(performance.now() - t0).toFixed(1),
  };
  console.log(JSON.stringify(report, null, 2));

  const pass =
    report.vectorSearch.top5全部命中目标主题 && ftsHits.length > 0 && hybrid.length === 5;
  console.log(pass ? "SPIKE-② PASS" : "SPIKE-② FAIL");
  await sql.end();
  process.exit(pass ? 0 : 1);
}

await main();
