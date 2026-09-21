import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embed, generateText } from "ai";
import { createProvider } from "../src/providers/repository.js";
import { fakeProviderFactory, realProviderFactory } from "../src/providers/factory.js";
import { resolveModel } from "../src/providers/slots.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY as MASTER_KEY } from "./test-keys.js";

describe("模型槽位解析（#14，全离线 Fake）", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
    // 测试库跨文件共享：清空 provider_configs，保证槽位解析默认选择不受其他文件污染
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, MASTER_KEY, {
      name: "fake-llm",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-fake-offline-0000",
      models: { chat: "fake-chat-1", extraction: "fake-extract-1", embedding: "fake-embed-1" },
    });
    await createProvider(t.db, MASTER_KEY, {
      name: "chat-only",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-fake-offline-1111",
      models: { chat: "fake-chat-2" },
    });
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  it("chat 槽位：解析出配置的模型实例，调用方不感知厂商（Fake 可真实 generateText）", async () => {
    const { model, modelId, providerName } = await resolveModel(t.db, MASTER_KEY, "chat", {
      factory: fakeProviderFactory,
    });
    expect(modelId).toBe("fake-chat-1");
    expect(providerName).toBe("fake-llm");
    const result = await generateText({ model, prompt: "ping" });
    expect(result.text).toContain("fake-response");
  });

  it("extraction 槽位：取到独立指派的模型（三槽位互不影响）", async () => {
    const { modelId } = await resolveModel(t.db, MASTER_KEY, "extraction", {
      factory: fakeProviderFactory,
    });
    expect(modelId).toBe("fake-extract-1");
  });

  it("embedding 槽位：Fake embedding 模型可真实 embed", async () => {
    const { model, modelId } = await resolveModel(t.db, MASTER_KEY, "embedding", {
      factory: fakeProviderFactory,
    });
    expect(modelId).toBe("fake-embed-1");
    const result = await embed({ model, value: "hello" });
    expect(result.embedding.length).toBeGreaterThan(0);
  });

  it("槽位未配置任何 Provider 时报错", async () => {
    await expect(
      resolveModel(t.db, MASTER_KEY, "embedding", {
        providerName: "chat-only",
        factory: fakeProviderFactory,
      }),
    ).rejects.toThrow(/embedding/);
  });

  it("Anthropic 协议不支持 embedding 槽位（真实工厂，调用前即拒绝，无网络）", async () => {
    await createProvider(t.db, MASTER_KEY, {
      name: "claude",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-fake-0000",
      models: { chat: "claude-sonnet-4", embedding: "should-not-exist" },
    });
    await expect(
      resolveModel(t.db, MASTER_KEY, "embedding", {
        providerName: "claude",
        factory: realProviderFactory,
      }),
    ).rejects.toThrow(/Anthropic/i);
  });
});
