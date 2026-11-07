import { z } from "zod";
import { memoryContent, MemoryTokenLimitSchema, packMemoryContext } from "./context-budget.js";
import type { RetrievalCandidate } from "./search.js";

const Options = z
  .object({
    maxTokens: MemoryTokenLimitSchema,
    countTokens: z.custom<(text: string) => number>((v) => typeof v === "function"),
  })
  .strict();
export type RuntimeMemoryBudget = z.infer<typeof Options>;
export interface BudgetMetadata {
  salience: number | null;
  recordedFrom: string;
}
/** Clone numeric limit and pin callback identity before model/database awaits. */
export function parseRuntimeMemoryBudget(
  value: unknown,
  hasFusion: boolean,
): RuntimeMemoryBudget | undefined {
  if (value === undefined) return undefined;
  const parsed = Options.safeParse(value);
  if (!hasFusion || !parsed.success) throw Error("INVALID_RUNTIME_MEMORY_BUDGET");
  return parsed.data;
}
export function budgetShortlist(
  shortlist: RetrievalCandidate[],
  metadata: ReadonlyMap<string, BudgetMetadata>,
  budget: RuntimeMemoryBudget,
) {
  const packed = packMemoryContext(
    {
      maxTokens: budget.maxTokens,
      candidates: shortlist.map((c) => {
        const meta = metadata.get(c.beliefVersionId);
        if (!meta) throw Error("INVALID_MEMORY_BUDGET_INPUT");
        return { beliefVersionId: c.beliefVersionId, ...meta, content: memoryContent(c) };
      }),
    },
    budget.countTokens,
  );
  const byId = new Map(shortlist.map((c) => [c.beliefVersionId, c]));
  return {
    packed,
    selected: packed.selectedIds.map((id) => byId.get(id)!),
  };
}
