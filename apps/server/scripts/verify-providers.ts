/**
 * Provider 实调验证（#14 验收：DeepSeek chat 与 DashScope embedding 实调通）。
 * 运行：pnpm --filter @mnemic/server run verify:providers（自动加载仓库根 .env）
 * 走真实适配层（realProviderFactory），与生产同一代码路径。
 */
import { embed, generateText } from "ai";
import { realProviderFactory } from "../src/providers/factory.js";
import type { ProviderWithKey } from "../src/providers/repository.js";

function cfg(name: string, baseUrl: string, apiKey: string): ProviderWithKey {
  return {
    id: "manual-verify",
    name,
    protocol: "openai-compatible",
    baseUrl,
    apiKey,
    models: {},
    createdAt: new Date(),
  };
}

let failed = false;

if (process.env.DEEPSEEK_API_KEY) {
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const model = realProviderFactory.languageModel(
    cfg("deepseek", "https://api.deepseek.com/v1", process.env.DEEPSEEK_API_KEY),
    modelId,
  );
  const r = await generateText({ model, prompt: "用一句中文回答：1+1 等于几？" });
  console.log(`DeepSeek chat OK（${modelId}）：${r.text.slice(0, 60)}`);
} else {
  console.log("SKIP DeepSeek chat：DEEPSEEK_API_KEY 未配置");
  failed = true;
}

if (process.env.DASHSCOPE_API_KEY) {
  const model = realProviderFactory.embeddingModel(
    cfg("dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1",
      process.env.DASHSCOPE_API_KEY),
    "text-embedding-v4",
  );
  const r = await embed({ model, value: "mnemic 长期记忆" });
  console.log(`DashScope embedding OK：维度 ${r.embedding.length}`);
} else {
  console.log("SKIP DashScope embedding：DASHSCOPE_API_KEY 未配置（待补 Key 后重跑）");
}

if (failed) process.exitCode = 2;
