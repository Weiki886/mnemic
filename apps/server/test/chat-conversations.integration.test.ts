import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import type { EmbeddingModel, LanguageModel } from "ai";
import { buildApp } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import type { ProviderFactory } from "../src/providers/factory.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";

/** 批提取候选（高置信 + 具体值 → Gate WRITE） */
const EXTRACTION_JSON = JSON.stringify([
  {
    type: "decision",
    subject: "chat-proj",
    attribute: "database",
    value: "PostgreSQL",
    valid_time: "2026-09-24",
    time_precision: "DAY",
    time_confidence: 0.95,
    assertion_intent: "ASSERT",
    source_type: "USER_EXPLICIT",
    importance: 0.9,
    confidence: 0.9,
    entities: ["chat-proj", "PostgreSQL"],
    is_profile: true,
  },
]);

describe("对话闭环：会话创建与提交（#7 Task A）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let extractCalls: { prompt: string }[];

  beforeAll(async () => {
    t = await setupTestDb();
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "chat-fake",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-fake-offline-0000",
      models: { chat: "fake-chat", extraction: "fake-extract", embedding: "bag-1024" },
    });
    extractCalls = [];
    const extractionModel = new MockLanguageModelV2({
      doGenerate: async (opts) => {
        extractCalls.push({ prompt: JSON.stringify(opts.prompt) });
        return {
          content: [{ type: "text" as const, text: EXTRACTION_JSON }],
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
    const fakeFactory: ProviderFactory = {
      languageModel: () => extractionModel as unknown as LanguageModel,
      embeddingModel: (cfg, id) => bagEmbeddingFactory.embeddingModel(cfg, id) as EmbeddingModel,
    };
    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY, providerFactory: fakeFactory });
  }, 180_000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  const seedProject = async (name: string) => {
    const id = uuidv7();
    await t.sql`insert into projects (id, name) values (${id}, ${name})`;
    return id;
  };

  it("POST /v1/conversations：非法 project_id → 400 带结构化 errors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { project_id: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_FAILED");
    expect(res.json().errors[0].path).toBe("project_id");
  });

  it("POST /v1/conversations：项目不存在 → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { project_id: uuidv7() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
  });

  it("POST /v1/conversations：创建成功返回会话", async () => {
    const projectId = await seedProject("chat-create");
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { project_id: projectId, title: "讨论数据库选型" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBeDefined();
    expect(res.json().title).toBe("讨论数据库选型");
    expect(res.json().ended_at).toBeNull();
  });

  it("commit：不存在的会话 → 404", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${uuidv7()}/commit` });
    expect(res.statusCode).toBe(404);
  });

  it("commit：触发异步批提取，候选经完整写入路径入库（AC1）", async () => {
    const projectId = await seedProject("chat-commit");
    const conv = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: { project_id: projectId } })
    ).json();
    const messageId = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${messageId}, ${conv.id}, 'user', '我们数据库决定用 PostgreSQL', now())`;

    const before = extractCalls.length;
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/commit` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ended_at).not.toBeNull();
    expect(res.json().extraction_triggered).toBe(true);

    await waitForChatJobs();
    // 提取流程被调用，且输入包含会话原文
    expect(extractCalls.length).toBeGreaterThan(before);
    expect(extractCalls.at(-1)!.prompt).toContain("PostgreSQL");
    // 候选经完整写入路径入库：Observation 锚定会话最后一条消息，Belief 已建
    const obs = await t.sql`select evidence_id from observations where project_id = ${projectId} and attribute = 'database'`;
    expect(obs.length).toBe(1);
    expect(obs[0]!.evidence_id).toBe(messageId);
    const rows = await t.sql`select b.id from beliefs b where b.project_id = ${projectId} and b.attribute = 'database'`;
    expect(rows.length).toBe(1);
  });

  it("commit：重复提交 → 409", async () => {
    const projectId = await seedProject("chat-double-commit");
    const conv = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: { project_id: projectId } })
    ).json();
    const first = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/commit` });
    expect(first.statusCode).toBe(200);
    expect(first.json().extraction_triggered).toBe(false); // 空会话无消息可提取
    const second = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/commit` });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("CONFLICT");
  });
});
