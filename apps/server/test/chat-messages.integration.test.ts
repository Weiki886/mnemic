import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import type { EmbeddingModel, LanguageModel } from "ai";
import { buildApp } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import type { ProviderFactory } from "../src/providers/factory.js";
import { retrieve } from "../src/retrieval/search.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";

const candidateJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify([
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
      ...over,
    },
  ]);

describe("对话闭环：消息应答（#7 Task B）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let chatCalls: string[][];
  let extractionQueue: string[];
  let extractCalls: string[];
  let logChunks: string;
  let fakeFactory: ProviderFactory;

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
    chatCalls = [];
    extractionQueue = [];
    extractCalls = [];
    logChunks = "";
    const chatModel = new MockLanguageModelV2({
      doGenerate: async (opts) => {
        // system 消息 content 为纯字符串，user 消息为 text part 数组
        const texts = (opts.prompt as { content: unknown }[]).flatMap((m) =>
          typeof m.content === "string"
            ? [m.content]
            : (m.content as { type: string; text?: string }[])
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? ""),
        );
        chatCalls.push(texts);
        return {
          content: [{ type: "text" as const, text: texts.join("\n---\n") }],
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
    const extractionModel = new MockLanguageModelV2({
      doGenerate: async (opts) => {
        extractCalls.push(JSON.stringify(opts.prompt));
        return {
          content: [{ type: "text" as const, text: extractionQueue.shift() ?? "[]" }],
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
    fakeFactory = {
      languageModel: (_cfg, modelId) =>
        (modelId === "fake-extract" ? extractionModel : chatModel) as unknown as LanguageModel,
      embeddingModel: (cfg, id) => bagEmbeddingFactory.embeddingModel(cfg, id) as EmbeddingModel,
    };
    app = buildApp({
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      providerFactory: fakeFactory,
      logStream: { write: (chunk) => (logChunks += chunk) },
      chatDeps: {
        // 词袋 fake 相似度天然偏低，阈值放宽聚焦闭环逻辑（阈值本身已由 #6 专项覆盖）
        retrieveFn: (db, mk, pid, q, opts) => retrieve(db, mk, pid, q, { ...opts, threshold: 0.1 }),
      },
    });
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
  const createConv = async (projectId: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/v1/conversations",
        payload: { project_id: projectId },
      })
    ).json().id as string;
  const postMessage = (convId: string, text: string) =>
    app.inject({ method: "POST", url: `/v1/conversations/${convId}/messages`, payload: { text } });

  it("非法消息体 → 400 带结构化 errors", async () => {
    const res = await postMessage(uuidv7(), "");
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe("text");
  });

  it("不存在的会话 → 404", async () => {
    const res = await postMessage(uuidv7(), "你好");
    expect(res.statusCode).toBe(404);
  });

  it("E2E（AC2）：会话1告知 PostgreSQL → 会话2回答正确并附记忆来源", async () => {
    const projectId = await seedProject("chat-e2e");
    const conv1 = await createConv(projectId);
    extractionQueue.push(candidateJson());
    const res1 = await postMessage(conv1, "我们数据库决定用 PostgreSQL");
    expect(res1.statusCode).toBe(200);
    await waitForChatJobs();
    // 单条消息异步提取：候选入库且锚定该用户消息
    const userMsg =
      await t.sql`select id from messages where conversation_id = ${conv1} and speaker = 'user'`;
    const obs =
      await t.sql`select evidence_id from observations where project_id = ${projectId} and attribute = 'database'`;
    expect(obs.length).toBe(1);
    expect(obs[0]!.evidence_id).toBe(userMsg[0]!.id);

    const conv2 = await createConv(projectId);
    extractionQueue.push("[]");
    const res2 = await postMessage(conv2, "database 选型是 PostgreSQL 吗？");
    expect(res2.statusCode).toBe(200);
    expect(res2.json().abstained).toBe(false);
    // 回答使用了注入的记忆（echo 模型回显 prompt，记忆块含 PostgreSQL）
    expect(res2.json().answer).toContain("PostgreSQL");
    // 记忆来源以结构化字段随响应返回
    const memories = res2.json().memories;
    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0].value).toBe("PostgreSQL");
    expect(memories[0].belief_version_id).toBeDefined();
    // 助手回答已存为消息
    const assistantMsg =
      await t.sql`select raw_text from messages where id = ${res2.json().message_id} and speaker = 'assistant'`;
    expect(assistantMsg.length).toBe(1);
    await waitForChatJobs();
  });

  it("回答引用的记忆版本 ID 持久化到助手消息（#8 只读视图数据源）", async () => {
    const projectId = await seedProject("chat-cited");
    const conv1 = await createConv(projectId);
    extractionQueue.push(candidateJson());
    await postMessage(conv1, "我们数据库决定用 PostgreSQL");
    await waitForChatJobs();

    const conv2 = await createConv(projectId);
    extractionQueue.push("[]");
    const res = await postMessage(conv2, "database 选型是 PostgreSQL 吗？");
    expect(res.json().memories.length).toBeGreaterThan(0);
    const cited = res.json().memories[0].belief_version_id as string;
    // 响应里返回的引用必须落库：助手消息 memories 只存版本 ID（决策 8 引用不复制）
    const rows =
      await t.sql`select memories from messages where id = ${res.json().message_id} and speaker = 'assistant'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.memories).toEqual([cited]);
    await waitForChatJobs();
  });

  it("更新场景（AC3）：换 MySQL → 再问回答 MySQL 且旧版本留痕", async () => {
    const projectId = await seedProject("chat-update");
    const conv = await createConv(projectId);
    extractionQueue.push(candidateJson());
    await postMessage(conv, "我们数据库用 PostgreSQL");
    await waitForChatJobs();
    extractionQueue.push(
      candidateJson({
        value: "MySQL",
        valid_time: "2026-09-25",
        assertion_intent: "UPDATE",
        entities: ["chat-proj", "MySQL"],
      }),
    );
    await postMessage(conv, "换成 MySQL 了");
    await waitForChatJobs();

    extractionQueue.push("[]");
    const res = await postMessage(conv, "database 现在用的是什么？");
    expect(res.json().answer).toContain("MySQL");
    expect(res.json().memories[0].value).toBe("MySQL");
    await waitForChatJobs();
    // 旧版本留痕：两个版本，旧版本 recorded_to 已封止
    const versions = await t.sql`
      select bv.value, bv.recorded_to from belief_versions bv
      join beliefs b on b.id = bv.belief_id
      where b.project_id = ${projectId} and b.attribute = 'database'
      order by bv.recorded_from asc`;
    expect(versions.length).toBe(2);
    expect(versions[0]!.value).toBe("PostgreSQL");
    expect(versions[0]!.recorded_to).not.toBeNull();
    expect(versions[1]!.value).toBe("MySQL");
    expect(versions[1]!.recorded_to).toBeNull();
  });

  it("无相关记忆（AC4）：拒答标记 + 提示词允许说不知道", async () => {
    const projectId = await seedProject("chat-empty");
    const conv = await createConv(projectId);
    const before = chatCalls.length;
    const res = await postMessage(conv, "我们的消息队列选型是什么？");
    expect(res.statusCode).toBe(200);
    expect(res.json().abstained).toBe(true);
    expect(res.json().memories).toEqual([]);
    // 系统提示词明确允许"不知道"（无记忆时不诱导编造）
    expect(chatCalls.length).toBe(before + 1);
    expect(chatCalls.at(-1)![0]).toContain("不知道");
    await waitForChatJobs();
  });

  it("检索失败降级：不阻塞对话，记警告日志", async () => {
    const degraded = buildApp({
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      providerFactory: fakeFactory,
      logStream: { write: (chunk) => (logChunks += chunk) },
      chatDeps: {
        retrieveFn: async () => {
          throw new Error("embedding backend down");
        },
      },
    });
    const projectId = await seedProject("chat-degraded");
    const conv = (
      await degraded.inject({
        method: "POST",
        url: "/v1/conversations",
        payload: { project_id: projectId },
      })
    ).json().id as string;
    const res = await degraded.inject({
      method: "POST",
      url: `/v1/conversations/${conv}/messages`,
      payload: { text: "随便聊聊" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBeDefined();
    expect(res.json().memories).toEqual([]);
    expect(res.json().abstained).toBe(true);
    expect(logChunks).toContain("retrieval failed");
    await degraded.close();
    await waitForChatJobs();
  });

  it("已提交会话 → 409", async () => {
    const projectId = await seedProject("chat-ended");
    const conv = await createConv(projectId);
    await app.inject({ method: "POST", url: `/v1/conversations/${conv}/commit` });
    const res = await postMessage(conv, "还能说吗");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CONFLICT");
  });

  it("先发消息再 commit：同一句话只提取一次，佐证不重复计数（决策 6）", async () => {
    const projectId = await seedProject("chat-no-dup-extract");
    const conv = await createConv(projectId);
    extractionQueue.push(candidateJson());
    await postMessage(conv, "我们数据库决定用 PostgreSQL");
    await waitForChatJobs();

    const res = await app.inject({ method: "POST", url: `/v1/conversations/${conv}/commit` });
    expect(res.statusCode).toBe(200);
    // 所有 user 消息都已被单条路径提取过，commit 无可提取对象
    expect(res.json().extraction_triggered).toBe(false);
    await waitForChatJobs();

    const obs = await t.sql`select id from observations where project_id = ${projectId}`;
    expect(obs.length).toBe(1);
    const versions = await t.sql`
      select bv.id, b.evidence_count from belief_versions bv
      join beliefs b on b.id = bv.belief_id where b.project_id = ${projectId}`;
    expect(versions.length).toBe(1);
    expect(versions[0]!.evidence_count).toBe(1);
  });

  it("commit 只提取未提取过的消息，出处锚定消息自身", async () => {
    const projectId = await seedProject("chat-selective-commit");
    const conv = await createConv(projectId);
    extractionQueue.push(candidateJson());
    await postMessage(conv, "我们数据库决定用 PostgreSQL");
    await waitForChatJobs();
    // 模拟离线导入的消息（未经 messages 接口，未被提取）
    const offlineMsgId = uuidv7();
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${offlineMsgId}, ${conv}, 'user', 'ORM 选了 Drizzle', now())`;

    extractionQueue.push(
      candidateJson({ attribute: "orm", value: "Drizzle", entities: ["chat-proj", "Drizzle"] }),
    );
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${conv}/commit` });
    expect(res.json().extraction_triggered).toBe(true);
    await waitForChatJobs();

    // commit 提取的输入只含未提取过的消息，不重送已提取的 msg1
    const commitExtractPrompt = extractCalls.at(-1)!;
    expect(commitExtractPrompt).toContain("Drizzle");
    expect(commitExtractPrompt).not.toContain("PostgreSQL");

    // 新候选只锚定离线消息；已提取过的消息不产生重复 Observation
    const obs =
      await t.sql`select attribute, evidence_id from observations where project_id = ${projectId} order by attribute`;
    expect(obs.length).toBe(2);
    expect(obs[0]!.attribute).toBe("database");
    expect(obs[1]!.attribute).toBe("orm");
    expect(obs[1]!.evidence_id).toBe(offlineMsgId);
  });
});
