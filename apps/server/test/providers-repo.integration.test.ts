import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProvider,
  getProviderWithKey,
  listProviders,
} from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY as MASTER_KEY } from "./test-keys.js";

describe("provider_configs 仓储（#14）", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
    // 测试库跨运行持久：清理本文件用例行，保证重跑幂等
    await t.sql`delete from provider_configs where name = 'deepseek'`;
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  const input = {
    name: "deepseek",
    protocol: "openai-compatible" as const,
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test-plaintext-key-1234",
    models: { chat: "deepseek-flash", extraction: "deepseek-flash" },
  };

  it("创建：Key 加密落库（密文 v1: 前缀，不含明文），返回掩码视图", async () => {
    const created = await createProvider(t.db, MASTER_KEY, input);
    expect(created.apiKeyMasked).toBe("sk-••••1234");
    expect(created).not.toHaveProperty("apiKey");
    expect(created).not.toHaveProperty("apiKeyEncrypted");
    expect(created.models).toEqual(input.models);

    // 库中原始行：密文存在且不含明文
    const raw = await t.sql`
      select api_key_encrypted from provider_configs where name = 'deepseek'
    `;
    expect(raw[0]!.api_key_encrypted as string).toMatch(/^v1:/);
    expect(raw[0]!.api_key_encrypted as string).not.toContain(input.apiKey);
  });

  it("列表：全部掩码，任何字段不泄露明文与密文", async () => {
    const list = await listProviders(t.db, MASTER_KEY);
    const found = list.find((p) => p.name === "deepseek");
    expect(found).toBeDefined();
    expect(found!.apiKeyMasked).toBe("sk-••••1234");
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(input.apiKey);
    expect(serialized).not.toContain("v1:");
  });

  it("服务内部可取回明文（仅服务端链路使用）", async () => {
    const withKey = await getProviderWithKey(t.db, MASTER_KEY, "deepseek");
    expect(withKey.apiKey).toBe(input.apiKey);
    expect(withKey.protocol).toBe("openai-compatible");
  });

  it("name 唯一约束", async () => {
    await expect(createProvider(t.db, MASTER_KEY, input)).rejects.toThrow();
  });

  it("protocol 枚举约束：fake 等非枚举值被拒", async () => {
    await expect(
      t.sql`
        insert into provider_configs (id, name, protocol, base_url, api_key_encrypted, models)
        values (${crypto.randomUUID()}, 'bad', 'fake', 'http://x', 'v1:a:b:c', '{}'::jsonb)
      `,
    ).rejects.toThrow();
  });
});
