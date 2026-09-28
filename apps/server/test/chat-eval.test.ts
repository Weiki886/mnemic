import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";

/**
 * 真实模型对话闭环评测（#7 验证计划：DeepSeek 样例集 ≥20 条，手动/定期触发）。
 * 全链路真实：DeepSeek chat+extraction、DashScope embedding、真实 PG——
 * 作为 Proposal §10 A0 端到端验收证据（CI Fake 不足以证明真实提取链路成立）。
 * 本地有 DEEPSEEK_API_KEY + DASHSCOPE_API_KEY 时运行，CI 跳过。
 */

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // CI 无 .env，跳过
}

const deepseekKey = process.env.DEEPSEEK_API_KEY;
const dashscopeKey = process.env.DASHSCOPE_API_KEY;
const chatModelId = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

const FACT_SAMPLES = [
  { tell: "我们项目的数据库用 PostgreSQL", ask: "我们数据库用的是什么？", expect: "postgresql" },
  { tell: "前端框架定了 Vue 3", ask: "前端用什么框架？", expect: "vue" },
  { tell: "ORM 选了 Drizzle", ask: "我们 ORM 用哪个？", expect: "drizzle" },
  { tell: "缓存层用 Redis", ask: "缓存用什么？", expect: "redis" },
  { tell: "包管理器用 pnpm", ask: "项目包管理器是什么？", expect: "pnpm" },
  { tell: "Node 版本统一到 24", ask: "Node 用哪个版本？", expect: "24" },
  { tell: "测试框架用 Vitest", ask: "测试用什么框架？", expect: "vitest" },
  { tell: "部署目标是 Fly.io", ask: "我们部署到哪个平台？", expect: "fly.io" },
];

const UPDATE_SAMPLES = [
  { tell: "数据库用 MySQL", then: "数据库换成 PostgreSQL 了", ask: "数据库现在用哪个？", expect: "postgresql" },
  { tell: "前端用 React", then: "前端改成 Vue 3 了", ask: "前端框架现在是什么？", expect: "vue" },
  { tell: "缓存用 Memcached", then: "缓存换成 Redis 了", ask: "缓存现在用什么？", expect: "redis" },
  { tell: "Node 版本是 22", then: "Node 升级到 24 了", ask: "现在 Node 版本是多少？", expect: "24" },
];

const ABSTAIN_SAMPLES = [
  "我们的消息队列选型是什么？",
  "搜索引擎用的是什么？",
  "日志采集方案定了吗？",
  "CDN 厂商选的哪家？",
];

const PROFILE_SAMPLES = [
  { tell: "用户模块已经写完 80%", ask: "用户模块进度如何？", expect: "80%" },
  { tell: "我更喜欢用英文写提交信息", ask: "提交信息用什么语言写？", expect: "英文" },
  { tell: "上周完成了登录模块", ask: "登录模块什么时候完成的？", expect: "上周" },
  { tell: "团队习惯周五做发布", ask: "一般周几发布？", expect: "周五" },
];

describe.skipIf(!deepseekKey || !dashscopeKey)("真实模型对话闭环评测（#7，手动/本地）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    t = await setupTestDb();
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "deepseek-eval",
      protocol: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: deepseekKey!,
      models: { chat: chatModelId, extraction: chatModelId },
    });
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "dashscope-eval",
      protocol: "openai-compatible",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: dashscopeKey!,
      models: { embedding: "text-embedding-v4" },
    });
    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  /** 独立项目跑一组"告知→（可选更新）→跨会话提问"，返回回答与检索标记 */
  const runScenario = async (tells: string[], ask: string) => {
    const projectId = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'chat-eval')`;
    const conv1 = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: { project_id: projectId } })
    ).json().id as string;
    for (const tell of tells) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/conversations/${conv1}/messages`,
        payload: { text: tell },
      });
      expect(res.statusCode).toBe(200);
      await waitForChatJobs();
    }
    const conv2 = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: { project_id: projectId } })
    ).json().id as string;
    const asked = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conv2}/messages`,
      payload: { text: ask },
    });
    expect(asked.statusCode).toBe(200);
    await waitForChatJobs();
    return asked.json() as { answer: string; memories: { value: unknown }[]; abstained: boolean };
  };

  it(
    `事实记忆问答：${FACT_SAMPLES.length} 条样例，跨会话召回正确率 ≥6/8`,
    { timeout: 900_000 },
    async () => {
      const rows = [];
      for (const s of FACT_SAMPLES) {
        const r = await runScenario([s.tell], s.ask);
        rows.push({ tell: s.tell, expect: s.expect, answer: r.answer.slice(0, 40), hit: r.answer.toLowerCase().includes(s.expect) });
      }
      console.table(rows);
      const hits = rows.filter((r) => r.hit).length;
      console.log(`事实问答命中率 ${hits}/${FACT_SAMPLES.length} model=${chatModelId}`);
      expect(hits).toBeGreaterThanOrEqual(6);
    },
  );

  it(
    `更新覆盖问答：${UPDATE_SAMPLES.length} 条样例，回答取新值 ≥3/4`,
    { timeout: 900_000 },
    async () => {
      const rows = [];
      for (const s of UPDATE_SAMPLES) {
        const r = await runScenario([s.tell, s.then], s.ask);
        rows.push({ then: s.then, expect: s.expect, answer: r.answer.slice(0, 40), hit: r.answer.toLowerCase().includes(s.expect) });
      }
      console.table(rows);
      const hits = rows.filter((r) => r.hit).length;
      console.log(`更新问答命中率 ${hits}/${UPDATE_SAMPLES.length} model=${chatModelId}`);
      expect(hits).toBeGreaterThanOrEqual(3);
    },
  );

  it(
    `无记忆拒答：${ABSTAIN_SAMPLES.length} 条样例，全部返回拒答标记`,
    { timeout: 600_000 },
    async () => {
      const rows = [];
      for (const ask of ABSTAIN_SAMPLES) {
        const r = await runScenario([], ask);
        rows.push({ ask, abstained: r.abstained, answer: r.answer.slice(0, 40) });
      }
      console.table(rows);
      // 全新项目无任何 Belief，检索必拒答（确定性断言）；模型措辞只记录不强制
      expect(rows.every((r) => r.abstained)).toBe(true);
    },
  );

  it(
    `进度/偏好/时间类问答：${PROFILE_SAMPLES.length} 条样例，召回正确率 ≥3/4`,
    { timeout: 900_000 },
    async () => {
      const rows = [];
      for (const s of PROFILE_SAMPLES) {
        const r = await runScenario([s.tell], s.ask);
        rows.push({ tell: s.tell, expect: s.expect, answer: r.answer.slice(0, 40), hit: r.answer.toLowerCase().includes(s.expect.toLowerCase()) });
      }
      console.table(rows);
      const hits = rows.filter((r) => r.hit).length;
      console.log(`画像类问答命中率 ${hits}/${PROFILE_SAMPLES.length} model=${chatModelId}`);
      expect(hits).toBeGreaterThanOrEqual(3);
    },
  );
});
