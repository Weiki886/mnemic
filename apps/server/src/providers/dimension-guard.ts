import type postgres from "postgres";

/**
 * embedding 维度守卫（#14）：启动时校验部署配置的 embedding 维度与库中
 * memory_embeddings.embedding 列维度一致；不一致拒绝启动并提示 REEMBED 流程。
 * embedding 维度为部署级配置（MNEMIC_EMBEDDING_DIMENSIONS），不可经用户接口修改（ADR-005）。
 */

export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

export function embeddingDimensionsFromEnv(): number {
  const raw = process.env.MNEMIC_EMBEDDING_DIMENSIONS;
  if (!raw) return DEFAULT_EMBEDDING_DIMENSIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`MNEMIC_EMBEDDING_DIMENSIONS 非法：${raw}`);
  }
  return n;
}

export function assertDimensionMatch(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `embedding 维度不匹配：部署配置 ${expected}，库中向量列 ${actual}。` +
        `禁止原地 ALTER；请按 REEMBED 流程迁移（#1 §11）。`,
    );
  }
}

/** 读 memory_embeddings.embedding 列的 vector 维度（pg_attribute.atttypmod） */
export async function getEmbeddingColumnDimension(sql: postgres.Sql): Promise<number> {
  const rows = await sql`
    select atttypmod from pg_attribute
    where attrelid = 'public.memory_embeddings'::regclass and attname = 'embedding'
  `;
  if (rows.length === 0) {
    throw new Error("memory_embeddings.embedding 列不存在（迁移未执行？）");
  }
  return rows[0]!.atttypmod as number;
}

export async function assertEmbeddingDimensions(
  sql: postgres.Sql,
  expected: number = embeddingDimensionsFromEnv(),
): Promise<void> {
  const actual = await getEmbeddingColumnDimension(sql);
  assertDimensionMatch(actual, expected);
}
