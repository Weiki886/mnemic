import { wrapLanguageModel, type LanguageModel, type EmbeddingModel } from "ai";
import type { UsageRecord } from "./repository.js";

type Language = Exclude<LanguageModel, string>;
type Embedding = Exclude<EmbeddingModel, string>;
type Usage = Awaited<ReturnType<Language["doGenerate"]>>["usage"];
type Base = Pick<
  UsageRecord,
  "projectId" | "conversationId" | "providerName" | "modelId" | "slot" | "purpose"
>;
type Sink = (record: UsageRecord) => Promise<void>;
const count = (n: number | undefined): number | null =>
  Number.isSafeInteger(n) && n! >= 0 ? n! : null;

function attempt(base: Base, sink: Sink, signal?: AbortSignal) {
  signal?.throwIfAborted(); // No provider invocation means no usage row.
  const snapshot = { ...base },
    startedAt = new Date(),
    start = performance.now();
  let saved: Promise<void> | undefined;
  const finish = (status: UsageRecord["status"], usage?: Usage) => {
    if (!saved) {
      saved = Promise.resolve()
        .then(() =>
          sink({
            ...snapshot,
            startedAt,
            durationMs: Math.max(0, Math.floor(performance.now() - start)),
            status,
            promptTokens: count(usage?.inputTokens),
            completionTokens: count(usage?.outputTokens),
            totalTokens: count(usage?.totalTokens),
            reasoningTokens: count(usage?.reasoningTokens),
            cachedInputTokens: count(usage?.cachedInputTokens),
          }),
        )
        .catch(() => {
          // Telemetry failure must not trigger SDK retries of a successful paid call. No raw DB payload.
          console.warn("model usage persistence failed");
        });
    }
    return saved;
  };
  return { finish, failed: () => (signal?.aborted ? ("aborted" as const) : ("error" as const)) };
}

/** Observe actual SDK invocations, not high-level extraction attempts or HTTP requests. */
export function observeLanguage(model: Language, base: Base, sink: Sink): Language {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        const a = attempt(base, sink, params.abortSignal);
        try {
          const result = await doGenerate();
          await a.finish(
            params.abortSignal?.aborted
              ? "aborted"
              : result.finishReason === "error"
                ? "error"
                : "success",
            result.usage,
          );
          return result;
        } catch (error) {
          await a.finish(a.failed());
          throw error;
        }
      },
      wrapStream: async ({ doStream, params }) => {
        const signal = params.abortSignal,
          a = attempt(base, sink, signal);
        let usage: Usage | undefined,
          status: UsageRecord["status"] = "error";
        const finish = (s = status) => {
          signal?.removeEventListener("abort", abort);
          return a.finish(s, usage);
        };
        const abort = () => {
          void finish("aborted");
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const result = await doStream(),
            reader = result.stream.getReader();
          let errored = false;
          return {
            ...result,
            stream: new ReadableStream({
              async pull(controller) {
                try {
                  const part = await reader.read();
                  if (part.done) {
                    await finish(signal?.aborted ? "aborted" : status);
                    reader.releaseLock();
                    controller.close();
                    return;
                  }
                  if (part.value.type === "error") {
                    errored = true;
                    status = "error";
                  }
                  if (part.value.type === "finish") {
                    usage = part.value.usage;
                    status = errored || part.value.finishReason === "error" ? "error" : "success";
                  }
                  controller.enqueue(part.value);
                } catch (error) {
                  await finish(a.failed());
                  reader.releaseLock();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                await finish("aborted");
                try {
                  await reader.cancel(reason);
                } finally {
                  reader.releaseLock();
                }
              },
            }),
          };
        } catch (error) {
          await finish(a.failed());
          throw error;
        }
      },
    },
  });
}

/** Embedding V2 has no middleware API. Preserve its capability getters and receiver. */
export function observeEmbedding(model: Embedding, base: Base, sink: Sink): Embedding {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    get maxEmbeddingsPerCall() {
      return model.maxEmbeddingsPerCall;
    },
    get supportsParallelCalls() {
      return model.supportsParallelCalls;
    },
    async doEmbed(params) {
      const a = attempt(base, sink, params.abortSignal);
      try {
        const result = await model.doEmbed(params);
        await a.finish(params.abortSignal?.aborted ? "aborted" : "success", {
          inputTokens: result.usage?.tokens,
          outputTokens: undefined,
          totalTokens: result.usage?.tokens,
        });
        return result;
      } catch (error) {
        await a.finish(a.failed());
        throw error;
      }
    },
  };
}
