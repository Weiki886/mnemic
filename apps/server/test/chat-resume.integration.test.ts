import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModel } from "ai";
import { buildApp } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";

describe("会话续聊与历史上下文（#31）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  const prompts: unknown[] = [];
  let extractions = 0;
  let generationGate: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    t = await setupTestDb();
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "resume-offline",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "offline-key",
      models: { chat: "chat", extraction: "extract", embedding: "bag" },
    });
    app = buildApp({
      auth: false,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      providerFactory: {
        ...bagEmbeddingFactory,
        languageModel: (_cfg, id) =>
          new MockLanguageModelV2({
            doGenerate: async (opts) => {
              if (id === "chat") {
                prompts.push(opts.prompt);
                await generationGate?.();
              } else extractions++;
              return {
                content: [{ type: "text", text: id === "chat" ? "继续昨天的工作" : "[]" }],
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                warnings: [],
              };
            },
          }) as unknown as LanguageModel,
      },
      chatDeps: {
        retrieveFn: async () => ({ candidates: [], abstained: true, traceId: uuidv7() }),
      },
    });
  }, 180000);
  afterAll(async () => {
    await waitForChatJobs();
    await app.close();
    await t.close();
  });
  async function seed(open = false) {
    const p = uuidv7(),
      c = uuidv7(),
      u = uuidv7(),
      a = uuidv7();
    await t.sql`insert into projects (id, name) values (${p}, 'resume')`;
    await t.sql`insert into conversations (id, project_id, title, ended_at) values (${c}, ${p}, '昨天', ${open ? null : "2026-10-19T01:00:00Z"})`;
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time, extracted_at) values
      (${u}, ${c}, 'user', '昨天确定验证码为42', '2026-10-19T00:00:00Z', now()),
      (${a}, ${c}, 'assistant', '已经记录，请继续', '2026-10-19T00:00:01Z', null)`;
    return { p, c, u, a };
  }
  const resume = (p: string, c: string, body: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/projects/${p}/conversations/${c}/resume`, payload: body });
  const send = (c: string, text = "接着昨天的工作") =>
    app.inject({ method: "POST", url: `/v1/conversations/${c}/messages`, payload: { text } });
  async function cite(s: Awaited<ReturnType<typeof seed>>, value = "旧的注入记忆") {
    const b = uuidv7(),
      v = uuidv7();
    await t.sql`insert into beliefs (id, project_id, subject, attribute) values (${b}, ${s.p}, '项目', 'database')`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from, resolver_version) values (${v}, ${b}, ${JSON.stringify(value)}::jsonb, now(), now(), 'test')`;
    await t.sql`update beliefs set current_version_id = ${v} where id = ${b}`;
    await t.sql`update messages set memories = ${JSON.stringify([v])}::jsonb where id = ${s.a}`;
    return { b, v };
  }

  it("已提交会话恢复成新 ID：旧记录不变，只保存消息引用，不复制或提取 Evidence", async () => {
    const s = await seed();
    const before = extractions;
    const r = await resume(s.p, s.c);
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.id).not.toBe(s.c);
    expect(body.resumed_from).toBe(s.c);
    expect(body.ended_at).toBeNull();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([s.u, s.a]);
    const rows = await t.sql`select ended_at, meta from conversations where id = ${s.c}`;
    expect(new Date(rows[0]!.ended_at).toISOString()).toBe("2026-10-19T01:00:00.000Z");
    expect((await t.sql`select id from messages where conversation_id = ${body.id}`).length).toBe(
      0,
    );
    const [fork] = await t.sql`select meta from conversations where id = ${body.id}`;
    expect(fork!.meta.resume.message_ids).toEqual([s.u, s.a]);
    expect(JSON.stringify(fork!.meta)).not.toContain("验证码");
    await waitForChatJobs();
    expect(extractions).toBe(before);
    expect((await send(s.c)).statusCode).toBe(409);
  });
  it("当前会话和开放来源一并归档；失败的跨项目切换不改任一状态", async () => {
    const source = await seed(true),
      current = await seed(true);
    await t.sql`update conversations set project_id = ${source.p} where id = ${current.c}`;
    const foreign = await seed(true);
    expect(
      (await resume(source.p, foreign.c, { current_conversation_id: current.c })).statusCode,
    ).toBe(404);
    expect(
      (await t.sql`select ended_at from conversations where id = ${current.c}`)[0]!.ended_at,
    ).toBeNull();
    expect(
      (await resume(source.p, source.c, { current_conversation_id: foreign.c })).statusCode,
    ).toBe(404);
    const r = await resume(source.p, source.c, { current_conversation_id: current.c });
    expect(r.statusCode).toBe(201);
    const archived =
      await t.sql`select ended_at from conversations where id in (${source.c}, ${current.c})`;
    expect(archived.every((c) => c.ended_at !== null)).toBe(true);
    expect(r.json().messages.map((m: { id: string }) => m.id)).toEqual([source.u, source.a]);
  });
  it("续聊后再次恢复，历史只引用一次；详情/列表可见完整历史，新消息只提取一次", async () => {
    const s = await seed();
    const before = extractions;
    const restored = await resume(s.p, s.c);
    expect(restored.statusCode).toBe(201);
    const first = restored.json();
    expect((await send(first.id)).statusCode).toBe(200);
    await waitForChatJobs();
    const second = await resume(s.p, first.id);
    expect(second.statusCode).toBe(201);
    expect(second.json().messages).toHaveLength(4);
    expect(new Set(second.json().messages.map((m: { id: string }) => m.id)).size).toBe(4);
    expect(
      (await t.sql`select id from messages where conversation_id = ${second.json().id}`).length,
    ).toBe(0);
    const detail = await app.inject(`/projects/${s.p}/conversations/${second.json().id}`);
    expect(detail.json().messages).toHaveLength(4);
    const list = (await app.inject(`/projects/${s.p}/conversations`)).json();
    expect(list.find((c: { id: string }) => c.id === second.json().id).message_count).toBe(4);
    await waitForChatJobs();
    expect(extractions - before).toBe(1);
  });
  it("正常多轮与恢复后模型都收到历史角色、原文和历史记忆，而非只收到最后一句", async () => {
    const s = await seed(true);
    await cite(s);
    const r = await send(s.c);
    expect(r.statusCode).toBe(200);
    expect(r.json().history_included).toBe(true);
    let prompt = JSON.stringify(prompts.at(-1));
    expect(prompt).toContain("昨天确定验证码为42");
    expect(prompt).toContain("已经记录");
    expect(prompt).toContain("旧的注入记忆");
    const fork = (await resume(s.p, s.c)).json();
    expect((await send(fork.id, "恢复后继续")).statusCode).toBe(200);
    prompt = JSON.stringify(prompts.at(-1));
    expect(prompt).toContain("昨天确定验证码为42");
    expect(prompt).toContain("旧的注入记忆");
    expect(prompt).toContain("恢复后继续");
    await waitForChatJobs();
  });
  it("无历史且无检索记忆仍明确拒答", async () => {
    const s = await seed();
    const created = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: { project_id: s.p } })
    ).json();
    const r = await send(created.id);
    expect(r.json().abstained).toBe(true);
    expect(r.json().history_included).toBe(false);
    await waitForChatJobs();
  });
  it("不信任历史引用：跨项目消息 ID 恢复失败且不归档来源", async () => {
    const own = await seed(true),
      foreign = await seed();
    const meta = { resume: { version: 1, from: foreign.c, message_ids: [foreign.u] } };
    await t.sql`update conversations set meta = ${JSON.stringify(meta)}::jsonb where id = ${own.c}`;
    const r = await resume(own.p, own.c);
    expect(r.statusCode).toBe(409);
    expect(r.body).not.toContain("验证码");
    expect(
      (await t.sql`select ended_at from conversations where id = ${own.c}`)[0]!.ended_at,
    ).toBeNull();
  });
  it("跨项目记忆引用和已删除记忆不会作为额外历史记忆注入模型", async () => {
    const own = await seed(true),
      foreign = await seed();
    const f = await cite(foreign, "FOREIGN-SECRET");
    await t.sql`update messages set memories = ${JSON.stringify([f.v])}::jsonb where id = ${own.a}`;
    expect((await send(own.c)).statusCode).toBe(200);
    expect(JSON.stringify(prompts.at(-1))).not.toContain("FOREIGN-SECRET");
    const d = await cite(own, "DELETED-SECRET");
    await t.sql`update beliefs set status = 'deleted' where id = ${d.b}`;
    expect((await send(own.c)).statusCode).toBe(200);
    expect(JSON.stringify(prompts.at(-1))).not.toContain("DELETED-SECRET");
    await waitForChatJobs();
  });
  it("非法 UUID/正文为结构化400，专用修正会话不可恢复", async () => {
    const s = await seed();
    for (const [p, c, body] of [
      ["bad", s.c, {}],
      [s.p, "bad", {}],
      [s.p, s.c, { current_conversation_id: "bad" }],
      [s.p, s.c, { messages: [] }],
    ] as const) {
      const r = await resume(p, c, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().errors.length).toBeGreaterThan(0);
    }
    await t.sql`update conversations set title = 'manual-corrections' where id = ${s.c}`;
    expect((await resume(s.p, s.c)).statusCode).toBe(409);
  });
  it("恢复发生在生成期间：归档后不能再追加旧回答", async () => {
    const s = await seed(true);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    generationGate = async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
    };
    const pending = send(s.c, "正在回答的请求").then((r) => r);
    await ready;
    try {
      expect((await resume(s.p, s.c)).statusCode).toBe(201);
    } finally {
      generationGate = undefined;
      release();
    }
    expect((await pending).statusCode).toBe(409);
    expect((await t.sql`select id from messages where conversation_id = ${s.c}`).length).toBe(3);
    await waitForChatJobs();
  });
});
