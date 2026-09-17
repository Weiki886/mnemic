/**
 * Spike ①：DeepSeek 经 Vercel AI SDK generateObject 按 zod schema 提取的稳定性
 * 运行：DEEPSEEK_API_KEY=xxx pnpm --filter @mnemic/spike run spike:deepseek
 * 采样 ≥20 次，统计 schema 合法率与延迟；结果写入 docs/spike-deepseek-results.json
 *
 * 关键发现（2026-09-17 探测）：deepseek-flash 为推理模型，其 OpenAI 兼容端点
 * 不支持 structuredOutputs，SDK 注入的 schema 会被模型忽略（自造字段名）。
 * 因此提取路径为：generateText + prompt 内显式文本 schema + zod 校验 + 失败重试。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("缺少 DEEPSEEK_API_KEY（见 .env.example）");
  process.exit(2);
}

// 与 #4 提取 schema 对齐的候选 Observation（spike 简化版）
const CandidateSchema = z.object({
  type: z.enum(["fact", "preference", "decision", "progress"]),
  subject: z.string(),
  attribute: z.string(),
  value: z.string(),
  valid_time: z.string().describe("ISO 8601 或模糊时间原文"),
  time_precision: z.enum(["DAY", "WEEK", "MONTH", "FUZZY"]),
  time_confidence: z.number().min(0).max(1),
  assertion_intent: z.enum(["ASSERT", "UPDATE", "CORRECT", "RETRACT"]),
  source_type: z.enum([
    "USER_CORRECTION",
    "USER_EXPLICIT",
    "PROJECT_FILE",
    "TOOL_OBSERVATION",
    "DOCUMENT",
    "WEB_CONTENT",
    "AGENT_INFERENCE",
  ]),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  entities: z.array(z.string()),
  is_profile: z.boolean(),
});

const SAMPLES = [
  "我们数据库用 PostgreSQL，ORM 选 Drizzle",
  "前端框架定了，Vue 3 加 Vite",
  "部署到 VPS，用 Docker Compose 加 Caddy 反代",
  "我上周说的那个方案作废，缓存层不要 Redis 了",
  "最近进度：用户模块写完 80%，下周开始订单模块",
  "记一下，我偏好 pnpm，别用 npm",
  "刚才说错了，Node 版本是 24 不是 22",
  "考试周那两周暂停开发，之后恢复",
  "CLI 用 Ink 做，参考 Codex 的交互",
  "测试框架 Vitest，集成测试用 Testcontainers",
  "模型接入走 OpenAI 兼容协议，先做 DeepSeek 和千问",
  "这个项目是毕设，截止明年五月",
  "API 错误格式统一 problem+json",
  "权限模型先做单用户 Bearer token，不做账号体系",
  "embedding 用通义的，DeepSeek 没有 embedding 模型",
  "搜索结果要支持拒答，不确定就说不记得",
  "以后所有提交信息都用英文",
  "等我确认之后再合并 PR",
  "记忆中心页面要有版本时间线",
  "当我没说过要加 Redis 那句话",
];

const deepseek = createOpenAICompatible({
  name: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  apiKey,
});

const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

// 文本式 schema（推理模型会忽略 API 层注入，必须写进 prompt）
const SCHEMA_TEXT = `{
  "type": "fact" | "preference" | "decision" | "progress",
  "subject": string, "attribute": string, "value": string,
  "valid_time": "ISO 8601 或模糊时间原文",
  "time_precision": "DAY" | "WEEK" | "MONTH" | "FUZZY",
  "time_confidence": 0~1,
  "assertion_intent": "ASSERT" | "UPDATE" | "CORRECT" | "RETRACT",
  "source_type": "USER_CORRECTION" | "USER_EXPLICIT" | "PROJECT_FILE" | "TOOL_OBSERVATION" | "DOCUMENT" | "WEB_CONTENT" | "AGENT_INFERENCE",
  "importance": 0~1, "confidence": 0~1,
  "entities": string[], "is_profile": boolean
}`;

function buildPrompt(input: string): string {
  return (
    `从下面的用户话语中提取一条记忆候选，输出 json。今天是 2026-09-17。\n` +
    `输出必须是符合以下 schema 的单个 json 对象（不要输出任何其他内容）：\n${SCHEMA_TEXT}\n` +
    `断言意图判断：普通陈述=ASSERT，"改用/换成"=UPDATE，"说错了"=CORRECT，"当我没说过"=RETRACT。\n` +
    `是否画像类（is_profile）：技术栈/进度/未决问题类为 true。\n\n` +
    `用户话语：${input}`
  );
}

/** 剥离可能的 markdown 围栏后解析并校验 */
function parseCandidate(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return CandidateSchema.safeParse(JSON.parse(cleaned));
  } catch {
    return CandidateSchema.safeParse(null);
  }
}

async function main() {
  const results: {
    input: string;
    ok: boolean;
    retried: boolean;
    ms: number;
    error?: string;
    output?: unknown;
  }[] = [];

  for (const input of SAMPLES) {
    const t0 = performance.now();
    let retried = false;
    let parsed = null as ReturnType<typeof parseCandidate> | null;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      retried = attempt > 0;
      const { text } = await generateText({
        model: deepseek(modelId),
        temperature: 0,
        prompt: buildPrompt(input),
      });
      parsed = parseCandidate(text);
      if (parsed.success) break;
      lastError = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    }
    const ms = +(performance.now() - t0).toFixed(0);
    if (parsed?.success) {
      results.push({ input, ok: true, retried, ms, output: parsed.data });
    } else {
      results.push({ input, ok: false, retried, ms, error: lastError || "parse failed" });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const retriedOk = results.filter((r) => r.ok && r.retried).length;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    model: modelId,
    temperature: 0,
    path: "generateText + 文本 schema + zod 校验 + 1 次重试",
    samples: results.length,
    schemaValid: ok,
    schemaValidRate: +(ok / results.length).toFixed(3),
    retriedButValid: retriedOk,
    latencyMs: {
      p50: latencies[Math.floor(latencies.length * 0.5)],
      p95: latencies[Math.floor(latencies.length * 0.95)],
      max: latencies[latencies.length - 1],
    },
    failures: results.filter((r) => !r.ok).map((r) => ({ input: r.input, error: r.error })),
    timestamp: new Date().toISOString(),
  };

  await writeFile(
    new URL("../../docs/spike-deepseek-results.json", import.meta.url),
    JSON.stringify({ summary, results }, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
  const pass = summary.schemaValidRate >= 0.95;
  console.log(pass ? "SPIKE-① PASS" : "SPIKE-① FAIL（合法率 <95%，回 #1 讨论方案）");
  process.exit(pass ? 0 : 1);
}

await main();
