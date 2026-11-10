import { z } from "zod";
import pino from "pino";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ModelQuotaError, type ModelAdmission } from "../quota/repository.js";
import { assertUsageScope } from "../usage/read.js";
import { writeModelUsage, type UsageRecord } from "../usage/repository.js";
import type { UsageLogger } from "../usage/models.js";
import { createQwenReranker } from "./qwen-reranker.js";
import { parseRerankInput, type RerankResult } from "./reranker-input.js";

const Scope = z
  .object({
    projectId: z.string().uuid().toLowerCase(),
    conversationId: z.string().uuid().toLowerCase().nullable(),
  })
  .strict();
const logger = pino({ name: "reranker-usage", level: process.env.LOG_LEVEL ?? "info" });

/** Internal preparation for #9. No retrieval caller, config slot, flag enablement or HTTP endpoint. */
export function createMeteredQwenReranker(
  db: PostgresJsDatabase,
  config: unknown,
  options: { admitModelCall: ModelAdmission; usageLogger?: UsageLogger },
) {
  if (!options || typeof options.admitModelCall !== "function")
    throw Error("INVALID_RERANK_OBSERVER_CONFIG");
  const admit = options.admitModelCall,
    warning = (options.usageLogger ?? logger).warn.bind(options.usageLogger ?? logger),
    client = createQwenReranker(config);
  return Object.freeze({
    model: client.model,
    async rerank(value: unknown, scopeValue: unknown, signal?: AbortSignal): Promise<RerankResult> {
      // Synchronous schema parsing copies IDs and text before scope checks/admission can yield.
      const input = parseRerankInput(value);
      let scope: z.infer<typeof Scope>;
      try {
        scope = Scope.parse(scopeValue);
      } catch {
        throw Error("INVALID_RERANK_SCOPE");
      }
      const check = () => {
        if (signal?.aborted) throw Error("RERANK_ABORTED");
      };
      check();
      if (!input.documents.length) return { model: client.model, items: [], usage: null };
      try {
        await assertUsageScope(db, scope.projectId, scope.conversationId ?? undefined);
      } catch {
        check();
        throw Error("INVALID_RERANK_SCOPE");
      }
      check();
      try {
        await admit(signal);
      } catch (error) {
        check();
        if (error instanceof ModelQuotaError) throw error;
        throw Error("RERANK_ADMISSION_FAILED");
      }
      check(); // Reservations are never refunded, but cancellation here is not an invocation.
      const startedAt = new Date(),
        start = performance.now();
      let status: UsageRecord["status"] = "error",
        result: RerankResult | undefined;
      try {
        result = await client.rerank(input, signal);
        status = signal?.aborted ? "aborted" : "success";
        return result;
      } catch (error) {
        status = signal?.aborted ? "aborted" : "error";
        const codes = [
          "RERANK_ABORTED",
          "RERANK_TIMEOUT",
          "RERANK_FAILED",
          "RERANK_INVALID_RESPONSE",
        ];
        throw Error(
          error instanceof Error && codes.includes(error.message) ? error.message : "RERANK_FAILED",
        );
      } finally {
        // One row per actual Score API invocation, independent of response array size.
        // Only allowlisted counts/identity leave the adapter; no raw response, endpoint or content.
        try {
          await writeModelUsage(db, {
            ...scope,
            providerName: "qwen-score-api",
            modelId: client.model,
            slot: "reranker",
            purpose: "rerank",
            status,
            startedAt,
            durationMs: Math.max(0, Math.floor(performance.now() - start)),
            promptTokens: result?.usage?.inputTokens ?? null,
            completionTokens: result?.usage?.outputTokens ?? null,
            totalTokens: result?.usage?.totalTokens ?? null,
            reasoningTokens: null,
            cachedInputTokens: null,
          });
        } catch {
          try {
            warning("model usage persistence failed");
          } catch {
            /* Never replay a paid request. */
          }
        }
      }
    },
  });
}
