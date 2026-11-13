import { z } from "zod";
import { parseRuntimeFusion, type RuntimeFusion } from "./runtime-fusion.js";
import { MAX_RERANK_DOCUMENTS } from "./reranker-input.js";
import { RerankerProviderSelectionSchema } from "./runtime-reranker.js";

const Binding = z
  .object({
    fusion: z.unknown(),
    rerankerProvider: RerankerProviderSelectionSchema,
  })
  .strict();
export type RecallBinding = Readonly<{
  fusion: RuntimeFusion;
  rerankerProvider: Readonly<z.infer<typeof RerankerProviderSelectionSchema>>;
}>;

/** Trusted library assembly only: never populate this from an HTTP body or model output. */
export function captureRecallBinding(value: unknown): RecallBinding | undefined {
  if (value === undefined) return undefined;
  try {
    const input = Binding.parse(value);
    const fusion = parseRuntimeFusion(input.fusion);
    if (!fusion || fusion.maxCandidates > MAX_RERANK_DOCUMENTS) throw Error();
    return Object.freeze({
      fusion: Object.freeze(
        fusion.mode === "weighted" ? { ...fusion, weights: Object.freeze(fusion.weights) } : fusion,
      ),
      rerankerProvider: Object.freeze(input.rerankerProvider),
    });
  } catch {
    throw Error("INVALID_RECALL_BINDING");
  }
}
