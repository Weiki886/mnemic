import { embed } from "ai";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { retrievalTraces } from "../db/schema.js";
import { resolveModel, type ResolveOptions } from "../providers/slots.js";

// A0 融合权重与拒答阈值（校准归 #12 评测平台，勿分散硬编码）
export const VECTOR_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;
export const DEFAULT_TOP_K = 5;
export const ABSTAIN_THRESHOLD = 0.3;
/** 读时强化幅度（受控实验例外，仅 reinforce 开启时生效；校准归 #12） */
export const REINFORCE_BOOST = 0.05;

export interface RetrievalCandidate {
  beliefId: string;
  beliefVersionId: string;
  subject: string;
  attribute: string;
  value: unknown;
  vectorScore: number | null;
  keywordScore: number | null;
  fusedScore: number;
  selected: boolean;
  reason: "top_k" | "below_topk" | "below_threshold";
}

export interface RetrieveResult {
  /** 入选候选（selected=true，Top-K）；拒答时为空 */
  candidates: RetrievalCandidate[];
  abstained: boolean;
  traceId: string;
}

export interface RetrieveOptions extends ResolveOptions {
  topK?: number;
  /** 拒答阈值（默认 ABSTAIN_THRESHOLD；#12/#22 实验配置可调） */
  threshold?: number;
  /** 读时强化实验钩子（#22 消融开关，默认关闭；env MNEMIC_READ_REINFORCE=1 也可开） */
  reinforce?: boolean;
}

/**
 * 两路混合检索（#6）：语义向量（pgvector cosine）+ tsvector 关键词，加权融合取 Top-K。
 * 证据不足 → 拒答标记；每次检索落 retrieval_traces（只存 ID 与得分）。
 * 读取路径默认不改变任何强度字段（决策 6）；reinforce 开启为受控实验例外并入 trace。
 */
export async function retrieve(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  projectId: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const threshold = options.threshold ?? ABSTAIN_THRESHOLD;
  const reinforce = options.reinforce ?? process.env.MNEMIC_READ_REINFORCE === "1";

  // 1. 查询向量化（无 embedding 配置时降级为仅关键词路，向量路空集）
  let queryVec: number[] | null = null;
  try {
    const { model } = await resolveModel(db, masterKey, "embedding", options);
    queryVec = (await embed({ model, value: query })).embedding;
  } catch {
    queryVec = null;
  }
  // 向量字面量占位：queryVec 为 null 时 vec CTE 零行（where false），
  // 占位用单位向量——零向量会使 cosine 距离产生 NaN，必须避开
  const vecLiteral = `[${(queryVec ?? [1, ...new Array(1023).fill(0)]).join(",")}]`;

  // 2. 两路召回 + 加权融合（仅当前版本 + active belief）
  const rows = await db.execute(sql`
    with vec as (
      select me.belief_version_id as version_id,
             1 - (me.embedding <=> ${vecLiteral}::vector) as vscore
      from memory_embeddings me
      where ${queryVec !== null}
    ), kw as (
      select bv.id as version_id,
             ts_rank(to_tsvector('simple', bv.value::text), plainto_tsquery('simple', ${query})) as kscore
      from belief_versions bv
      where to_tsvector('simple', bv.value::text) @@ plainto_tsquery('simple', ${query})
    ), kwn as (
      -- ts_rank 原始值（~0.01-0.1）与 cosine（0~1）量级悬殊，按本查询内最大值归一
      -- 使两路可加权融合；本查询零命中时 CTE 为空集，不受影响
      select version_id, kscore / nullif(max(kscore) over (), 0) as kscore from kw
    )
    select b.id as belief_id, bv.id as version_id, b.subject, b.attribute, bv.value,
           vec.vscore, kwn.kscore,
           (${VECTOR_WEIGHT} * coalesce(vec.vscore, 0) + ${KEYWORD_WEIGHT} * coalesce(kwn.kscore, 0)) as fused
    from beliefs b
    join belief_versions bv on bv.id = b.current_version_id
    left join vec on vec.version_id = bv.id
    left join kwn on kwn.version_id = bv.id
    where b.project_id = ${projectId} and b.status = 'active'
      and (vec.vscore is not null or kwn.kscore is not null)
    order by fused desc
  `);

  const all = rows.map((r): RetrievalCandidate => {
    const vectorScore = r.vscore === null ? null : Number(r.vscore);
    const keywordScore = r.kscore === null ? null : Number(r.kscore);
    return {
      beliefId: r.belief_id as string,
      beliefVersionId: r.version_id as string,
      subject: r.subject as string,
      attribute: r.attribute as string,
      value: r.value,
      vectorScore,
      keywordScore,
      fusedScore: Number(r.fused),
      selected: false,
      reason: "below_threshold",
    };
  });

  // 3. 拒答判定：零命中或最高融合分低于阈值
  const abstained = all.length === 0 || all[0]!.fusedScore < threshold;
  all.forEach((c, i) => {
    c.selected = !abstained && i < topK;
    c.reason = c.selected ? "top_k" : abstained ? "below_threshold" : "below_topk";
  });
  const selected = all.filter((c) => c.selected);

  // 4. trace 落库（只存 ID 与得分，不存内容快照；开关状态入 trace）
  const traceId = uuidv7();
  await db.insert(retrievalTraces).values({
    id: traceId,
    projectId,
    queryText: query,
    candidates: all.map((c) => ({
      beliefVersionId: c.beliefVersionId,
      vectorScore: c.vectorScore,
      keywordScore: c.keywordScore,
      fusedScore: c.fusedScore,
      selected: c.selected,
      reason: c.reason,
    })),
    abstained,
    reinforceEnabled: reinforce,
  });

  // 5. 读时强化实验钩子（默认关闭；开启时入选 belief 的 salience 提升并落库）
  if (reinforce && selected.length > 0) {
    for (const c of selected) {
      await db.execute(sql`
        update beliefs set salience = least(1, salience + ${REINFORCE_BOOST})
        where id = ${c.beliefId}
      `);
    }
  }

  return { candidates: selected, abstained, traceId };
}
