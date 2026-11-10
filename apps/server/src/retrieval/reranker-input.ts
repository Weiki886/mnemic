import { z } from "zod";

export const QWEN_RERANKER_MODEL = "Qwen/Qwen3-Reranker-0.6B";
export const MAX_RERANK_DOCUMENTS = 200;
export const MAX_RERANK_RESPONSE_BYTES = 256 * 1024;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\0\p{Cs}]*$/u)
    .refine((s) => s.trim().length > 0);
const Input = z
  .object({
    query: text(8192),
    documents: z
      .array(
        z
          .object({ beliefVersionId: z.string().uuid().toLowerCase(), content: text(16384) })
          .strict(),
      )
      .max(MAX_RERANK_DOCUMENTS),
  })
  .strict();
export type RerankInput = z.infer<typeof Input>;
export function parseRerankInput(value: unknown): RerankInput {
  try {
    if (value && typeof value === "object") {
      const documents = (value as Record<string, unknown>).documents;
      if (!Array.isArray(documents) || documents.length > MAX_RERANK_DOCUMENTS) throw Error();
    }
    const input = Input.parse(value),
      ids = new Set<string>();
    let size = Buffer.byteLength(input.query, "utf8");
    if (size > 8192) throw Error();
    for (const doc of input.documents) {
      const bytes = Buffer.byteLength(doc.content, "utf8");
      if (bytes > 16384 || ids.has(doc.beliefVersionId)) throw Error();
      ids.add(doc.beliefVersionId);
      size += bytes;
    }
    if (size > 65536) throw Error();
    return input;
  } catch {
    throw Error("INVALID_RERANK_INPUT");
  }
}

const Config = z
  .object({
    endpoint: z.string().min(1).max(2048),
    apiKey: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    timeoutMs: z.number().int().min(1).max(30000).default(5000),
  })
  .strict();
export function parseRerankConfig(value: unknown) {
  try {
    const config = Config.parse(value),
      url = new URL(config.endpoint);
    const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
      config.endpoint.trim() !== config.endpoint ||
      /[\p{Cc}\p{Cs}?#]/u.test(config.endpoint) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/score") ||
      !(url.protocol === "https:" || (url.protocol === "http:" && local))
    )
      throw Error();
    return { ...config, endpoint: url.href };
  } catch {
    throw Error("INVALID_RERANK_CONFIG");
  }
}

const Wire = z.object({
  object: z.literal("list"),
  model: z.literal(QWEN_RERANKER_MODEL),
  data: z
    .array(
      z.object({
        object: z.literal("score"),
        index: z
          .number()
          .int()
          .min(0)
          .max(MAX_RERANK_DOCUMENTS - 1),
        score: z.number().finite().min(0).max(1),
      }),
    )
    .max(MAX_RERANK_DOCUMENTS),
  usage: z.unknown().optional(),
});
const token = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Discard provider IDs, content, exceptions and every unrecognized metadata field. */
export function projectRerankResponse(value: unknown, input: RerankInput) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as Record<string, unknown>).data) ||
    (value as { data: unknown[] }).data.length !== input.documents.length
  )
    throw Error("RERANK_INVALID_RESPONSE");
  const parsed = Wire.safeParse(value);
  if (!parsed.success) throw Error("RERANK_INVALID_RESPONSE");
  const indices = new Set<number>();
  for (const row of parsed.data.data) {
    if (row.index >= input.documents.length || indices.has(row.index))
      throw Error("RERANK_INVALID_RESPONSE");
    indices.add(row.index);
  }
  const raw = parsed.data.usage;
  const usage =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  return {
    model: QWEN_RERANKER_MODEL,
    items: parsed.data.data
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((row, i) => ({
        beliefVersionId: input.documents[row.index]!.beliefVersionId,
        score: row.score,
        rank: i + 1,
      })),
    usage: usage
      ? {
          inputTokens: token(usage.prompt_tokens),
          outputTokens: token(usage.completion_tokens),
          totalTokens: token(usage.total_tokens),
        }
      : null,
  };
}
export type RerankResult = ReturnType<typeof projectRerankResponse>;
