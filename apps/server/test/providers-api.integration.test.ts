import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

describe("Providers 配置 API（#14）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    t = await setupTestDb();
    // 测试库跨运行持久：清理本文件用例行，保证重跑幂等
    await t.sql`delete from provider_configs where name in ('api-deepseek', 'x1', 'x2')`;
    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  const validBody = {
    name: "api-deepseek",
    protocol: "openai-compatible",
    base_url: "https://api.deepseek.com/v1",
    api_key: "sk-api-test-plainkey-5678",
    models: { chat: "deepseek-flash", extraction: "deepseek-flash" },
  };

  it("POST /providers：创建成功，响应为掩码视图，不回传明文", async () => {
    const res = await app.inject({ method: "POST", url: "/providers", payload: validBody });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.apiKeyMasked).toBe("sk-••••5678");
    expect(res.body).not.toContain(validBody.api_key);
    expect(res.body).not.toContain("v1:");
  });

  it("GET /providers：列表全部掩码，无明文无密文", async () => {
    const res = await app.inject({ method: "GET", url: "/providers" });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    const found = list.find((p: { name: string }) => p.name === "api-deepseek");
    expect(found.apiKeyMasked).toBe("sk-••••5678");
    expect(res.body).not.toContain(validBody.api_key);
    expect(res.body).not.toContain("v1:");
  });

  it("POST 校验失败：缺 api_key / 非法 protocol → 400 problem+json", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/providers",
      payload: { ...validBody, name: "x1", api_key: undefined },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect(missing.json().code).toBe("VALIDATION_FAILED");

    const badProtocol = await app.inject({
      method: "POST",
      url: "/providers",
      payload: { ...validBody, name: "x2", protocol: "fake" },
    });
    expect(badProtocol.statusCode).toBe(400);
  });

  it("POST 重名 → 409 CONFLICT problem+json", async () => {
    const res = await app.inject({ method: "POST", url: "/providers", payload: validBody });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CONFLICT");
  });

  it("未配置 DB/主密钥时路由不注册（404）", async () => {
    const bare = buildApp();
    const res = await bare.inject({ method: "GET", url: "/providers" });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
