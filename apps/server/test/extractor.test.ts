import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { extractCandidates } from "../src/extraction/extractor.js";

/** 依次返回给定文本的 Fake 模型（用于重试场景） */
function fakeModelReturning(texts: string[]): LanguageModel {
  let i = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: texts[Math.min(i++, texts.length - 1)]! }],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  }) as unknown as LanguageModel;
}

const candidateJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "decision",
    subject: "my-project",
    attribute: "database",
    value: "SQLite",
    valid_time: "2026-09-01",
    time_precision: "DAY",
    time_confidence: 0.95,
    assertion_intent: "UPDATE",
    source_type: "USER_CORRECTION",
    importance: 0.9,
    confidence: 0.88,
    entities: ["my-project", "SQLite"],
    is_profile: true,
    ...over,
  });

describe("结构化提取器（#4，Fake 模型）", () => {
  it("成功路径：JSON 数组解析、schema 校验、权威元数据挂载", async () => {
    const model = fakeModelReturning([`[${candidateJson()}]`]);
    const r = await extractCandidates(model, "数据库改用 SQLite", { today: "2026-09-22" });
    expect(r.degraded).toBe(false);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.authority).toBe(70);
    expect(r.candidates[0]!.reliability).toBeCloseTo(0.98);
    expect(r.attempts).toBe(1);
  });

  it("markdown 围栏输出可剥离解析", async () => {
    const model = fakeModelReturning(["```json\n[]\n```"]);
    const r = await extractCandidates(model, "随便聊聊", { today: "2026-09-22" });
    expect(r.degraded).toBe(false);
    expect(r.candidates).toHaveLength(0);
  });

  it("空数组是合法结果（无可记内容），不触发重试", async () => {
    const model = fakeModelReturning(["[]"]);
    const r = await extractCandidates(model, "今天天气不错", { today: "2026-09-22" });
    expect(r.degraded).toBe(false);
    expect(r.attempts).toBe(1);
  });

  it("非法/不完整候选被丢弃不入下游（部分合法保留 + droppedCount）", async () => {
    const broken = candidateJson({ assertion_intent: undefined });
    const model = fakeModelReturning([`[${candidateJson()}, ${broken}]`]);
    const r = await extractCandidates(model, "两条", { today: "2026-09-22" });
    expect(r.degraded).toBe(false);
    expect(r.candidates).toHaveLength(1);
    expect(r.droppedCount).toBe(1);
  });

  it("首次输出非法 JSON → 带反馈重试 → 成功", async () => {
    const model = fakeModelReturning(["这不是 JSON", `[${candidateJson()}]`]);
    const r = await extractCandidates(model, "数据库改用 SQLite", { today: "2026-09-22" });
    expect(r.degraded).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.candidates).toHaveLength(1);
  });

  it("全部输出非法 → 重试耗尽后降级：candidates 空、degraded、有日志", async () => {
    const logs: string[] = [];
    const model = fakeModelReturning(["garbage", "still garbage"]);
    const r = await extractCandidates(model, "输入", {
      today: "2026-09-22",
      logger: {
        warn: (o: object, m: string) => logs.push(`warn:${m}`),
        error: (o: object, m: string) => logs.push(`error:${m}`),
      },
    });
    expect(r.degraded).toBe(true);
    expect(r.candidates).toHaveLength(0);
    expect(r.error).toBeTruthy();
    expect(logs.some((l) => l.startsWith("error:"))).toBe(true);
  });

  it("全部候选 schema 非法（非空数组）视为失败并进入重试/降级", async () => {
    const model = fakeModelReturning([
      `[${candidateJson({ type: "memory" })}]`,
      `[${candidateJson({ type: "memory" })}]`,
    ]);
    const r = await extractCandidates(model, "输入", { today: "2026-09-22" });
    expect(r.degraded).toBe(true);
    expect(r.attempts).toBe(2);
  });
});
