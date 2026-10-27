import { MockLanguageModelV2, MockEmbeddingModelV2 } from "ai/test";
import { vi } from "vitest";
export const candidate = (extra: Record<string, unknown> = {}) => ({
  type: "decision",
  subject: "queue-project",
  attribute: "database",
  value: "PostgreSQL",
  valid_time: "2026-10-27",
  time_precision: "DAY",
  time_confidence: 1,
  assertion_intent: "ASSERT",
  source_type: "USER_EXPLICIT",
  importance: 0.9,
  confidence: 0.9,
  entities: ["queue-project"],
  is_profile: false,
  ...extra,
});
export function durableModels() {
  let output = JSON.stringify([candidate()]);
  const generate = vi.fn(async () => ({
    content: [{ type: "text" as const, text: output }],
    finishReason: "stop" as const,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    warnings: [],
  }));
  const embedding = vi.fn(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
    usage: { tokens: 3 },
  }));
  return {
    generate,
    embedding,
    output: (value: unknown) => {
      output = JSON.stringify(value);
    },
    factory: {
      languageModel: () =>
        new MockLanguageModelV2({
          doGenerate: generate,
          doStream: async () => ({
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: "text-start", id: "answer" });
                c.enqueue({ type: "text-delta", id: "answer", delta: "OFFLINE ANSWER" });
                c.enqueue({ type: "text-end", id: "answer" });
                c.enqueue({
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                });
                c.close();
              },
            }),
          }),
        }),
      embeddingModel: () => new MockEmbeddingModelV2<string>({ doEmbed: embedding }),
    },
  };
}
