import { wrapLanguageModel, type LanguageModel, type EmbeddingModel } from "ai";
import pino from "pino";
import type { ModelCapture, ModelDebugFactory } from "../debug/model-content.js";
import type { UsageRecord } from "./repository.js";

type Language = Exclude<LanguageModel, string>;
type Embedding = Exclude<EmbeddingModel, string>;
type Usage = Awaited<ReturnType<Language["doGenerate"]>>["usage"];
type Base = Pick<
  UsageRecord,
  "projectId" | "conversationId" | "providerName" | "modelId" | "slot" | "purpose"
>;
type Sink = (record: UsageRecord) => Promise<void>;
export interface UsageLogger {
  warn(message: string): void;
}
const defaultLogger = pino({ name: "model-usage", level: process.env.LOG_LEVEL ?? "info" });
const count = (n: number | undefined): number | null =>
  Number.isSafeInteger(n) && n! >= 0 ? n! : null;

function attempt(base: Base, sink: Sink, signal: AbortSignal | undefined, logger: UsageLogger) {
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
          try {
            logger.warn("model usage persistence failed");
          } catch {
            /* Logging cannot trigger a paid retry. */
          }
        });
    }
    return saved;
  };
  return { finish, failed: () => (signal?.aborted ? ("aborted" as const) : ("error" as const)) };
}

// Optional observability must be unable to throw into SDK retry handling.
function capture(
  factory: ModelDebugFactory | undefined,
  prompt: () => unknown,
): ModelCapture | undefined {
  if (!factory) return;
  try {
    const observer = factory(prompt());
    const safe = (run: () => void) => {
      try {
        run();
      } catch {
        /* Isolated debug sink. */
      }
    };
    return {
      output: (content, reason) => safe(() => observer.output(content, reason)),
      part: (part) => safe(() => observer.part(part)),
      finish: (status) => safe(() => observer.finish(status)),
    };
  } catch {
    return;
  }
}

/** Observe actual SDK invocations, not high-level extraction attempts or HTTP requests. */
export function observeLanguage(
  model: Language,
  base: Base,
  sink: Sink,
  logger: UsageLogger = defaultLogger,
  debug?: ModelDebugFactory,
): Language {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        const a = attempt(base, sink, params.abortSignal, logger);
        const observer = capture(debug, () => params.prompt);
        try {
          const result = await doGenerate();
          const status = params.abortSignal?.aborted
            ? "aborted"
            : result.finishReason === "error"
              ? "error"
              : "success";
          observer?.output(result.content, result.finishReason);
          observer?.finish(status);
          await a.finish(status, result.usage);
          return result;
        } catch (error) {
          observer?.finish(a.failed());
          await a.finish(a.failed());
          throw error;
        }
      },
      wrapStream: async ({ doStream, params }) => {
        const signal = params.abortSignal,
          a = attempt(base, sink, signal, logger);
        const observer = capture(debug, () => params.prompt);
        let usage: Usage | undefined,
          status: UsageRecord["status"] = "error";
        const finish = (s = status) => {
          signal?.removeEventListener("abort", abort);
          observer?.finish(s);
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
                  observer?.part(part.value);
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
                try {
                  // Stop the provider immediately, even when telemetry storage is slow.
                  await Promise.all([finish("aborted"), reader.cancel(reason)]);
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
export function observeEmbedding(
  model: Embedding,
  base: Base,
  sink: Sink,
  logger: UsageLogger = defaultLogger,
): Embedding {
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
      const a = attempt(base, sink, params.abortSignal, logger);
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
