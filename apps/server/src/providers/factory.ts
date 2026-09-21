import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, LanguageModel } from "ai";
import { MockEmbeddingModelV2, MockLanguageModelV2 } from "ai/test";
import type { ProviderWithKey } from "./repository.js";

/**
 * 双协议适配层（#14，ADR-005）：OpenAI 兼容协议为底座 + Anthropic Messages。
 * 领域模块禁止直接 import 模型 SDK，只能经此适配层取模型实例。
 */
export interface ProviderFactory {
  languageModel(config: ProviderWithKey, modelId: string): LanguageModel;
  embeddingModel(config: ProviderWithKey, modelId: string): EmbeddingModel;
}

export const realProviderFactory: ProviderFactory = {
  languageModel(config, modelId) {
    if (config.protocol === "anthropic") {
      return createAnthropic({ baseURL: config.baseUrl, apiKey: config.apiKey })(modelId);
    }
    return createOpenAICompatible({
      name: config.name,
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    })(modelId);
  },
  embeddingModel(config, modelId) {
    if (config.protocol === "anthropic") {
      throw new Error(
        "Anthropic 协议无 embedding 能力，embedding 槽位请配置 OpenAI 兼容端点（如 DashScope）",
      );
    }
    return createOpenAICompatible({
      name: config.name,
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    }).textEmbeddingModel(modelId);
  },
};

/** Fake 实现：离线测试用，可真实走 generateText/embed 调用路径但不发网络请求 */
export const fakeProviderFactory: ProviderFactory = {
  languageModel: () =>
    new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "fake-response" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
    }),
  embeddingModel: () =>
    new MockEmbeddingModelV2({
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => [0.1, 0.2, 0.3]),
      }),
    }),
};
