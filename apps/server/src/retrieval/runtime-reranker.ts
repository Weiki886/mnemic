import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { memoryContent } from "./context-budget.js";
import { createMeteredQwenReranker } from "./metered-reranker.js";
import { MAX_RERANK_DOCUMENTS } from "./reranker-input.js";
import type { RuntimeFusion } from "./runtime-fusion.js";
import type { RetrievalCandidate, RetrieveOptions } from "./search.js";

type Failure =
  "INVALID_RERANK_INPUT" | "RERANK_FAILED" | "RERANK_INVALID_RESPONSE" | "RERANK_TIMEOUT";
export type RerankerDetail =
  | { model: string; status: "applied"; score: number; rank: number }
  | { model: string; status: "skipped"; reason: "below_threshold" }
  | { model: string; status: "failed"; code: Failure };

/** Trusted experiment binding only. Configuration and dependency identity are copied before awaits. */
export function prepareRuntimeReranker(
  db: PostgresJsDatabase,
  projectId: string,
  options: RetrieveOptions,
  fusion: RuntimeFusion | undefined,
) {
  if (options.reranker === undefined) return undefined;
  if (
    !fusion ||
    fusion.maxCandidates > MAX_RERANK_DOCUMENTS ||
    options.flagsSnapshot === undefined ||
    typeof options.admitModelCall !== "function"
  )
    throw Error("INVALID_RUNTIME_RERANK_OPTIONS");
  const client = createMeteredQwenReranker(db, options.reranker, {
    admitModelCall: options.admitModelCall,
    ...(options.usageLogger ? { usageLogger: options.usageLogger } : {}),
  });
  const signal = options.signal;
  const check = () => {
    if (signal?.aborted) throw Error("RERANK_ABORTED");
  };
  check();
  const scope = {
    projectId,
    conversationId:
      options.usageContext?.projectId === projectId ? options.usageContext.conversationId : null,
  };
  return Object.freeze({
    check,
    async run(candidates: RetrievalCandidate[], query: string, abstained: boolean) {
      check();
      const details = new Map<string, RerankerDetail>();
      if (!candidates.length) return { candidates, details };
      if (abstained) {
        for (const c of candidates)
          details.set(c.beliefVersionId, {
            model: client.model,
            status: "skipped",
            reason: "below_threshold",
          });
        return { candidates, details };
      }
      try {
        const result = await client.rerank(
          {
            query,
            documents: candidates.map((c) => ({
              beliefVersionId: c.beliefVersionId,
              content: memoryContent(c),
            })),
          },
          scope,
          signal,
        );
        check();
        const byId = new Map(candidates.map((c) => [c.beliefVersionId, c]));
        for (const item of result.items)
          details.set(item.beliefVersionId, {
            model: result.model,
            status: "applied",
            score: item.score,
            rank: item.rank,
          });
        return { candidates: result.items.map((item) => byId.get(item.beliefVersionId)!), details };
      } catch (error) {
        const recoverable: readonly string[] = [
          "INVALID_RERANK_INPUT",
          "RERANK_FAILED",
          "RERANK_INVALID_RESPONSE",
          "RERANK_TIMEOUT",
        ];
        // Quota, admission/scope failures and explicit abort are not an enhancement failure.
        if (!(error instanceof Error) || !recoverable.includes(error.message)) throw error;
        for (const c of candidates)
          details.set(c.beliefVersionId, {
            model: client.model,
            status: "failed",
            code: error.message as Failure,
          });
        return { candidates, details };
      }
    },
  });
}
