import { z } from "zod";

/** Numbering and the empty marker are part of the text given to the model/tokenizer. */
export function renderMemoryContext(contents: readonly string[]): string {
  return contents.length === 0
    ? "（无相关记忆）"
    : contents.map((content, i) => `[${i + 1}] ${content}`).join("\n");
}

const Candidate = z
  .object({
    beliefVersionId: z.string().uuid().toLowerCase(),
    salience: z.number().finite().min(0).max(1).nullable(),
    recordedFrom: z
      .string()
      .datetime()
      .regex(/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/),
    content: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[^\0\p{Cs}]*$/u),
  })
  .strict();
const Input = z
  .object({
    maxTokens: z.number().int().min(0).max(1_000_000),
    candidates: z.array(Candidate).max(800),
  })
  .strict();

export interface MemoryBudgetResult {
  text: string;
  tokenCount: number;
  selectedIds: string[];
  /** Safe to include in a future retrieval trace; contains no content or tokenizer error. */
  discarded: { beliefVersionId: string; reason: "token_budget" }[];
}

/**
 * Internal pure prefix packer (#9). The trusted caller supplies the selected model's synchronous
 * tokenizer, never a default character estimate. Budget covers only the rendered memory block.
 * Does not query, invoke a model, write a trace, or enable any runtime feature flags.
 */
export function packMemoryContext(
  value: unknown,
  countTokens: (text: string) => number,
): MemoryBudgetResult {
  const invalid = () => Error("INVALID_MEMORY_BUDGET_INPUT");
  // Bound collections and UTF8 bytes before Zod traversal/copy or tokenizer work.
  if (!value || typeof value !== "object") throw invalid();
  const raw = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(raw) || raw.length > 800) throw invalid();
  let bytes = 0;
  for (const item of raw) {
    const text = item?.content;
    if (typeof text !== "string" || text.length > 16384) throw invalid();
    const size = Buffer.byteLength(text, "utf8");
    bytes += size;
    if (size > 16384 || bytes > 65536) throw invalid();
  }
  const parsed = Input.safeParse(value);
  if (!parsed.success) throw invalid();
  const { maxTokens, candidates } = parsed.data; // Detached before the first callback.
  if (new Set(candidates.map((c) => c.beliefVersionId)).size !== candidates.length) throw invalid();
  const timestamp = (s: string) => s.slice(0, 19) + "." + s.slice(20, -1).padEnd(6, "0");
  candidates.sort((a, b) => {
    const salience = (b.salience ?? -1) - (a.salience ?? -1);
    if (salience) return salience;
    const left = timestamp(a.recordedFrom),
      right = timestamp(b.recordedFrom);
    if (left !== right) return left > right ? -1 : 1;
    return a.beliefVersionId < b.beliefVersionId ? -1 : 1;
  });
  const count = (text: string) => {
    try {
      const n = countTokens(text);
      if (!Number.isSafeInteger(n) || n < 0) throw Error();
      return n;
    } catch {
      throw Error("MEMORY_TOKEN_COUNT_FAILED");
    }
  };
  let text = renderMemoryContext([]),
    tokenCount = count(text);
  if (tokenCount > maxTokens) throw Error("MEMORY_BUDGET_TOO_SMALL");
  const contents: string[] = [];
  for (const candidate of candidates) {
    const next = renderMemoryContext([...contents, candidate.content]);
    const nextCount = count(next);
    // Strict priority prefix: don't skip an oversized entry to admit a lower-priority one.
    if (nextCount > maxTokens) break;
    contents.push(candidate.content);
    text = next;
    tokenCount = nextCount;
  }
  return {
    text,
    tokenCount,
    selectedIds: candidates.slice(0, contents.length).map((c) => c.beliefVersionId),
    discarded: candidates.slice(contents.length).map((c) => ({
      beliefVersionId: c.beliefVersionId,
      reason: "token_budget",
    })),
  };
}
