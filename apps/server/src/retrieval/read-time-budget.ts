import { memoryContent, packMemoryContext } from "./context-budget.js";
import type { buildReadTimeContext } from "./read-time-context.js";
import type { BudgetMetadata, RuntimeMemoryBudget } from "./runtime-budget.js";

type ReplayContext = Awaited<ReturnType<typeof buildReadTimeContext>>;

/** Budget real replay text; anchor IDs identify priority metadata, never alternative provenance. */
export function budgetReadTimeContext(
  context: ReplayContext,
  metadata: ReadonlyMap<string, BudgetMetadata>,
  budget: RuntimeMemoryBudget,
) {
  const packed = packMemoryContext(
    {
      maxTokens: budget.maxTokens,
      candidates: context.memories.map((memory) => {
        const id = memory.provenance.anchorVersionId;
        const meta = metadata.get(id);
        if (!meta) throw Error("INVALID_MEMORY_BUDGET_INPUT");
        return { beliefVersionId: id, ...meta, content: memoryContent(memory) };
      }),
    },
    budget.countTokens,
  );
  const byId = new Map(
    context.memories.map((memory) => [memory.provenance.anchorVersionId, memory]),
  );
  const discarded = new Set(packed.discarded.map((item) => item.beliefVersionId));
  return {
    packed,
    context: {
      text: packed.text,
      memories: packed.selectedIds.map((id) => byId.get(id)!),
      outcomes: context.outcomes.map((outcome) => ({
        ...outcome,
        status:
          outcome.status === "selected" && discarded.has(outcome.anchorVersionId!)
            ? ("budget_discarded" as const)
            : outcome.status,
      })),
      abstained: packed.selectedIds.length === 0,
    },
  };
}
