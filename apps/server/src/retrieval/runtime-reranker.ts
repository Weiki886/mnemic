import { z } from "zod";
import {
  resolveConfiguredRerankerConfig,
  resolveProviderRerankerConfig,
} from "../providers/reranker.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { memoryContent } from "./context-budget.js";
import { createMeteredQwenReranker } from "./metered-reranker.js";
import { MAX_RERANK_DOCUMENTS, parseRerankInput, QWEN_RERANKER_MODEL } from "./reranker-input.js";
import type { RuntimeFusion } from "./runtime-fusion.js";
import type { RetrievalCandidate, RetrieveOptions } from "./search.js";

type Failure =
  "INVALID_RERANK_INPUT" | "RERANK_FAILED" | "RERANK_INVALID_RESPONSE" | "RERANK_TIMEOUT";
type Source = { providerId: string; revision: number };
export const RerankerProviderSelectionSchema = z
  .object({ providerId: z.string().uuid().toLowerCase().optional() })
  .strict();
export type RerankerDetail = (
  | { model: string; status: "applied"; score: number; rank: number }
  | { model: string; status: "skipped"; reason: "below_threshold" }
  | { model: string; status: "failed"; code: Failure }
) & { provider?: Source };

/** Trusted experiment binding only. Configuration and dependency identity are copied before awaits. */
export function prepareRuntimeReranker(
  db: PostgresJsDatabase,
  projectId: string,
  options: RetrieveOptions,
  fusion: RuntimeFusion | undefined,
  masterKey?: Buffer,
) {
  if (options.reranker === undefined && options.rerankerProvider === undefined) return undefined;
  const selected =
    options.rerankerProvider === undefined
      ? undefined
      : RerankerProviderSelectionSchema.safeParse(options.rerankerProvider);
  if (
    selected &&
    (!selected.success ||
      options.reranker !== undefined ||
      !Buffer.isBuffer(masterKey) ||
      masterKey.length !== 32)
  )
    throw Error("INVALID_RUNTIME_RERANK_OPTIONS");
  const descriptor = selected?.success ? selected.data : undefined;
  const capturedKey = descriptor ? Buffer.from(masterKey!) : undefined;
  if (
    !fusion ||
    fusion.maxCandidates > MAX_RERANK_DOCUMENTS ||
    (!descriptor && options.flagsSnapshot === undefined) ||
    typeof options.admitModelCall !== "function"
  )
    throw Error("INVALID_RUNTIME_RERANK_OPTIONS");
  const admit = options.admitModelCall;
  const logger = options.usageLogger
    ? { warn: options.usageLogger.warn.bind(options.usageLogger) }
    : undefined;
  const createClient = (config: unknown) =>
    createMeteredQwenReranker(db, config, {
      admitModelCall: admit,
      ...(logger ? { usageLogger: logger } : {}),
    });
  const eager = options.reranker === undefined ? undefined : createClient(options.reranker);
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
            model: QWEN_RERANKER_MODEL,
            status: "skipped",
            reason: "below_threshold",
          });
        return { candidates, details };
      }
      let source: Source | undefined;
      try {
        const input = parseRerankInput({
          query,
          documents: candidates.map((c) => ({
            beliefVersionId: c.beliefVersionId,
            content: memoryContent(c),
          })),
        });
        const resolved = descriptor
          ? await (descriptor.providerId
              ? resolveProviderRerankerConfig(db, capturedKey!, descriptor.providerId)
              : resolveConfiguredRerankerConfig(db, capturedKey!))
          : undefined;
        check();
        if (descriptor && !resolved) throw Error("RERANKER_PROVIDER_UNCONFIGURED");
        if (resolved) source = { providerId: resolved.providerId, revision: resolved.revision };
        const client = eager ?? createClient(resolved!.config);
        const result = await client.rerank(input, scope, signal);
        check();
        const byId = new Map(candidates.map((c) => [c.beliefVersionId, c]));
        for (const item of result.items)
          details.set(item.beliefVersionId, {
            ...(source ? { provider: source } : {}),
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
            model: QWEN_RERANKER_MODEL,
            ...(source ? { provider: source } : {}),
            status: "failed",
            code: error.message as Failure,
          });
        return { candidates, details };
      }
    },
  });
}
