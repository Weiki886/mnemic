import { captureReplayRetrievalBinding, type ReplayRetrievalBinding } from "./replay-binding.js";
import { parseRuntimeMemoryBudget, type RuntimeMemoryBudget } from "./runtime-budget.js";

export type ChatRetrievalBinding = ReplayRetrievalBinding &
  Readonly<{ memoryBudget?: Readonly<RuntimeMemoryBudget> }>;

/** Capture the trusted tokenizer and limit at app assembly, before any requests can run. */
export function captureChatRetrievalBinding(value: unknown): ChatRetrievalBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return captureReplayRetrievalBinding(value);

  const { memoryBudget, ...retrieval } = value as Record<string, unknown>;
  const binding = captureReplayRetrievalBinding(retrieval);
  if (!binding) return undefined;

  const budget = parseRuntimeMemoryBudget(memoryBudget, true);
  return budget ? Object.freeze({ ...binding, memoryBudget: Object.freeze(budget) }) : binding;
}
