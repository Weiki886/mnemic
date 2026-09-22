import { generateText, type LanguageModel } from "ai";
import { attachAuthority, type CandidateWithAuthority } from "./authority.js";
import { buildExtractionPrompt } from "./prompt.js";
import { CandidateSchema } from "./schema.js";

/**
 * 结构化提取器（#4）：对话 → 候选 Observation 数组。
 * 路径为 generateText + prompt 文本 schema + zod 校验 + 反馈重试（spike ① 结论：
 * 推理模型不支持 structuredOutputs，generateObject 不可用）。
 * 失败策略：最多 maxAttempts 次（默认 2，第二次携带上次错误反馈），
 * 耗尽后降级——candidates 空、degraded=true、错误入日志，绝不把非法输出放下游。
 */

export interface ExtractOptions {
  /** 注入"今天"（YYYY-MM-DD），保证时间分类可复现；缺省取当前日期 */
  today?: string;
  maxAttempts?: number;
  temperature?: number;
  logger?: {
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

export interface ExtractionResult {
  candidates: CandidateWithAuthority[];
  /** 非法/不完整候选被丢弃的数量（不入下游） */
  droppedCount: number;
  degraded: boolean;
  attempts: number;
  error?: string;
}

function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

/** 解析输出为候选数组；返回 null 表示整体失败（应重试），非法元素被丢弃 */
function parseCandidates(text: string): { valid: CandidateWithAuthority[]; dropped: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(text));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const valid: CandidateWithAuthority[] = [];
  let dropped = 0;
  for (const item of raw) {
    const r = CandidateSchema.safeParse(item);
    if (r.success) valid.push(attachAuthority(r.data));
    else dropped++;
  }
  // 非空数组但全部非法 = 模型系统性偏离，按整体失败处理
  if (raw.length > 0 && valid.length === 0) return null;
  return { valid, dropped };
}

export async function extractCandidates(
  model: LanguageModel,
  input: string,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const maxAttempts = options.maxAttempts ?? 2;
  let feedback: string | undefined;
  let lastError = "未知错误";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { text } = await generateText({
        model,
        prompt: buildExtractionPrompt(input, today, feedback),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      });
      const parsed = parseCandidates(text);
      if (parsed) {
        return {
          candidates: parsed.valid,
          droppedCount: parsed.dropped,
          degraded: false,
          attempts: attempt,
        };
      }
      lastError = "输出不是合法 JSON 数组或全部候选不符合 schema";
      feedback = lastError;
      options.logger?.warn({ attempt, input: input.slice(0, 80) }, "extraction attempt failed");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      feedback = `调用失败：${lastError}`;
      options.logger?.warn({ attempt, err: lastError }, "extraction attempt error");
    }
  }

  options.logger?.error({ input: input.slice(0, 80), error: lastError }, "extraction degraded");
  return {
    candidates: [],
    droppedCount: 0,
    degraded: true,
    attempts: maxAttempts,
    error: lastError,
  };
}
