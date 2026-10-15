import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockEmbeddingModelV2, MockLanguageModelV2 } from "ai/test";
import { DoctorReportSchema } from "@mnemic/shared";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

describe("doctor：服务端统一配置诊断（#19 1/2）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  const secret = "sk-doctor-secret-must-not-appear";
  const generate = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "OK" }],
    finishReason: "stop" as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  }));
  let dimensions = 1024;
  let failChat = false;
  const embed = vi.fn(async () => ({
    embeddings: [Array.from({ length: dimensions }, () => 0.1)],
  }));
  const logs: string[] = [];
  beforeAll(async () => {
    t = await setupTestDb();
    app = buildApp({
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      logStream: { write: (s) => logs.push(s) },
      providerFactory: {
        languageModel: (_config, modelId) =>
          new MockLanguageModelV2({
            doGenerate:
              failChat && modelId === "fake-chat"
                ? async () => {
                    throw new Error(`upstream ${secret}`);
                  }
                : generate,
          }),
        embeddingModel: () => new MockEmbeddingModelV2({ doEmbed: embed }),
      },
    });
  }, 180_000);
  beforeEach(async () => {
    generate.mockClear();
    embed.mockClear();
    dimensions = 1024;
    failChat = false;
    logs.length = 0;
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "doctor-fake",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      apiKey: secret,
      models: { chat: "fake-chat", extraction: "fake-extract", embedding: "fake-embed" },
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it("默认只读检查：配置来自服务端、模型未探测不标成功、鉴权未启用不假报通过", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/doctor" });
    expect(res.statusCode).toBe(200);
    const report = DoctorReportSchema.parse(res.json());
    expect(report).toMatchObject({ ok: true, probe: false, configSource: "server" });
    expect(report.checks.find((c) => c.name === "database")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "configuration")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "authentication")?.status).toBe("skipped");
    for (const name of ["chat", "extraction", "embedding"]) {
      expect(report.checks.find((c) => c.name === name)).toMatchObject({
        status: "skipped",
        provider: "doctor-fake",
      });
    }
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(res.body).not.toContain(secret);
  });

  it("显式 probe 实际调用两个文本槽位和 embedding，校验向量维度", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/doctor?probe=true" });
    const report = DoctorReportSchema.parse(res.json());
    expect(report.ok).toBe(true);
    expect(report.probe).toBe(true);
    for (const name of ["chat", "extraction", "embedding"]) {
      expect(report.checks.find((c) => c.name === name)?.status).toBe("ok");
    }
    expect(generate).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenCalledOnce();
    expect(res.body).not.toContain(secret);
  });

  it("模型失败有独立错误项，响应和日志均不包含上游异常/凭据", async () => {
    failChat = true;
    const res = await app.inject({ method: "GET", url: "/v1/doctor?probe=true" });
    const report = DoctorReportSchema.parse(res.json());
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => c.status === "error").map((c) => c.name)).toEqual(["chat"]);
    expect(report.checks.find((c) => c.name === "embedding")?.status).toBe("ok");
    expect(res.body + logs.join("")).not.toContain(secret);
    expect(res.body + logs.join("")).not.toContain("upstream");
  });

  it("缺失三槽位配置应失败而非当作模型可用", async () => {
    await t.sql`delete from provider_configs`;
    const res = await app.inject({ method: "GET", url: "/v1/doctor" });
    const report = DoctorReportSchema.parse(res.json());
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => c.status === "error").map((c) => c.name)).toEqual(
      expect.arrayContaining(["configuration", "chat", "extraction", "embedding"]),
    );
  });

  it("探测向量与部署维度不匹配时失败", async () => {
    dimensions = 3;
    const res = await app.inject({ method: "GET", url: "/v1/doctor?probe=true" });
    const report = DoctorReportSchema.parse(res.json());
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "embedding")?.status).toBe("error");
  });

  it("数据库列维度与部署配置不同会报告错误", async () => {
    vi.stubEnv("MNEMIC_EMBEDDING_DIMENSIONS", "1025");
    const res = await app.inject({ method: "GET", url: "/v1/doctor" });
    const report = DoctorReportSchema.parse(res.json());
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "embedding_dimensions")?.status).toBe("error");
  });

  it("未配置数据库的服务仍有诊断入口", async () => {
    const bare = buildApp({ logStream: { write: () => {} } });
    try {
      const res = await bare.inject({ method: "GET", url: "/v1/doctor" });
      expect(res.statusCode).toBe(200);
      const report = DoctorReportSchema.parse(res.json());
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => c.name === "database")?.status).toBe("error");
    } finally {
      await bare.close();
    }
  });

  it("非法 probe 参数返回带字段错误的 problem+json 400", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/doctor?probe=maybe" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [expect.objectContaining({ path: "probe" })],
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
