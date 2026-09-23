import { MockEmbeddingModelV2 } from "ai/test";
import type { ProviderFactory } from "../../src/providers/factory.js";

/**
 * 词袋哈希 embedding（测试专用）：每个 token 确定性映射到 1024 维向量的若干维度，
 * 累加后 L2 归一。token 重叠越多余弦相似度越高——可模拟"语义重叠"，
 * 用于在离线环境验证向量召回/加权融合逻辑（真实 Qwen3 联通性已由 #14 验证）。
 */
export function bagOfWordsVector(text: string, dim = 1024): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean)) {
    let h = 2166136261;
    for (const ch of token) {
      h ^= ch.codePointAt(0)!;
      h = Math.imul(h, 16777619);
    }
    for (let i = 0; i < 8; i += 1) {
      const idx = ((h + i * 0x9e3779b9) >>> 0) % dim;
      vec[idx]! += i % 2 === 0 ? 1 : -1;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** ProviderFactory：embedding 用词袋 fake；languageModel 不支持（检索链路不用） */
export const bagEmbeddingFactory: ProviderFactory = {
  languageModel: () => {
    throw new Error("bagEmbeddingFactory 不提供 languageModel");
  },
  embeddingModel: () =>
    new MockEmbeddingModelV2({
      doEmbed: async ({ values }) => ({
        embeddings: values.map((v) => bagOfWordsVector(v)),
      }),
    }),
};
