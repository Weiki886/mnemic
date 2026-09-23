import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/extraction/extractor.js";
import { realProviderFactory } from "../src/providers/factory.js";
import type { ProviderWithKey } from "../src/providers/repository.js";

/**
 * 真实模型提取评测（#4 验收：模糊时间分类正确率 ≥80%）。
 * 固定参考模型（DEEPSEEK_MODEL）与温度 0；本地有 DEEPSEEK_API_KEY 时运行，CI 跳过。
 * 每次运行输出逐条结果表，评测结论随 PR 记录。
 */

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // CI 无 .env，跳过
}

const apiKey = process.env.DEEPSEEK_API_KEY;
const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const TODAY = "2026-09-22";

const TIME_SAMPLES: { input: string; expect: "DAY" | "WEEK" | "MONTH" | "FUZZY" }[] = [
  { input: "昨天定了前端用 Vue 3", expect: "DAY" },
  { input: "前天把 PR 合并了", expect: "DAY" },
  { input: "刚才说错了，Node 版本是 24 不是 22", expect: "DAY" },
  { input: "上周我们把数据库换成了 SQLite", expect: "WEEK" },
  { input: "这周开始写订单模块", expect: "WEEK" },
  { input: "上上周暂停了一周开发", expect: "WEEK" },
  { input: "上个月完成了登录模块", expect: "MONTH" },
  { input: "这个月要搞定检索链路", expect: "MONTH" },
  { input: "去年十二月开题的", expect: "MONTH" },
  { input: "最近进度有点慢", expect: "FUZZY" },
  { input: "之前在考虑要不要加 Redis", expect: "FUZZY" },
  { input: "以后所有提交信息都用英文", expect: "FUZZY" },
];

const PROFILE_SAMPLES = [
  "我们数据库用 PostgreSQL，ORM 选 Drizzle",
  "最近进度：用户模块写完 80%，下周开始订单模块",
];

describe.skipIf(!apiKey)("真实模型提取评测（DeepSeek，手动/本地）", () => {
  const cfg: ProviderWithKey = {
    id: "eval",
    name: "deepseek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: apiKey!,
    models: {},
    createdAt: new Date(),
  };
  const model = realProviderFactory.languageModel(cfg, modelId);

  it(
    `模糊时间分类：${TIME_SAMPLES.length} 条样例正确率 ≥80%，time_confidence 随模糊度下降`,
    { timeout: 300_000 },
    async () => {
      const rows = await Promise.all(
        TIME_SAMPLES.map(async (s) => {
          const r = await extractCandidates(model, s.input, { today: TODAY, temperature: 0 });
          const c = r.candidates[0];
          return {
            input: s.input,
            expect: s.expect,
            actual: c?.time_precision ?? "(degraded)",
            time_confidence: c?.time_confidence ?? 0,
            hit: c?.time_precision === s.expect,
          };
        }),
      );
      console.table(rows);
      const hits = rows.filter((r) => r.hit).length;
      const accuracy = hits / rows.length;
      const meanConf = (p: string) => {
        const g = rows.filter((r) => r.expect === p);
        return g.reduce((a, b) => a + b.time_confidence, 0) / g.length;
      };
      console.log(
        `accuracy=${(accuracy * 100).toFixed(1)}%（${hits}/${rows.length}）` +
          ` meanConf DAY=${meanConf("DAY").toFixed(2)} FUZZY=${meanConf("FUZZY").toFixed(2)}` +
          ` model=${modelId} temperature=0 today=${TODAY}`,
      );
      expect(accuracy).toBeGreaterThanOrEqual(0.8);
      expect(meanConf("FUZZY")).toBeLessThan(meanConf("DAY"));
    },
  );

  it(
    "is_profile：技术栈/进度类候选被标记 true",
    { timeout: 120_000 },
    async () => {
      for (const input of PROFILE_SAMPLES) {
        const r = await extractCandidates(model, input, { today: TODAY, temperature: 0 });
        expect(r.degraded).toBe(false);
        expect(r.candidates.length).toBeGreaterThan(0);
        expect(r.candidates.some((c) => c.is_profile)).toBe(true);
      }
    },
  );
});
