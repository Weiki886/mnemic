import { z } from "zod";
import { captureManagedRetrievalBinding, type ManagedRetrievalBinding } from "./managed-binding.js";

const BudgetModel = z
  .object({ providerId: z.string().uuid().toLowerCase(), modelId: z.string().min(1) })
  .strict();

export type ChatRetrievalBinding = ManagedRetrievalBinding &
  Readonly<{ memoryBudgetModel?: Readonly<z.infer<typeof BudgetModel>> }>;

export function captureChatRetrievalBinding(value: unknown): ChatRetrievalBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return captureManagedRetrievalBinding(value);

  const { memoryBudgetModel, ...retrieval } = value as Record<string, unknown>;
  const binding = captureManagedRetrievalBinding(retrieval);
  if (memoryBudgetModel === undefined) return binding;

  const model = BudgetModel.safeParse(memoryBudgetModel);
  if (!binding?.memoryBudget || !model.success) throw Error("INVALID_CHAT_MEMORY_BUDGET_MODEL");
  return Object.freeze({ ...binding, memoryBudgetModel: Object.freeze(model.data) });
}
