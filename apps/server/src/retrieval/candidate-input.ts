import { z } from "zod";
import { RecallTimePointSchema } from "@mnemic/shared/memory";
import { RankFusionOptionsSchema } from "./fusion.js";
const text = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\p{Cc}\p{Cs}]*$/u);
const label = text.max(128);
const queryText = z
  .string()
  .trim()
  .max(1000)
  .regex(/^[^\0\p{Cs}]*$/u);
const Input = z
  .object({
    projectId: z.string().uuid().toLowerCase(),
    query: queryText.default(""),
    /** Trusted runtime query-label policy; explicit entities remain unchanged when omitted. */
    entityQuery: queryText.optional(),
    entities: z.array(label).max(32).default([]),
    validAt: RecallTimePointSchema.optional(),
    embedding: z
      .object({
        model: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\p{Cc}\p{Cs}]*$/u)
          .refine((s) => s.trim().length > 0),
        vector: z
          .array(z.number().finite())
          .length(1024)
          .refine((v) => v.some((n) => n !== 0)),
      })
      .strict()
      .nullable()
      .default(null),
    fusion: RankFusionOptionsSchema,
  })
  .strict()
  .refine((input) => !input.fusion.flags.retrieval_time || input.validAt !== undefined);
/** Bound collections before Zod traversal; copy all options before any asynchronous database wait. */
export function candidateInput(value: unknown) {
  const invalid = () => Error("INVALID_RECALL_INPUT");
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.entities !== undefined && (!Array.isArray(obj.entities) || obj.entities.length > 32))
      throw invalid();
    if (obj.embedding !== undefined && obj.embedding !== null) {
      if (typeof obj.embedding !== "object") throw invalid();
      const vector = (obj.embedding as Record<string, unknown>).vector;
      if (!Array.isArray(vector) || vector.length !== 1024) throw invalid();
    }
  }
  const parsed = Input.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
/** Requires candidateInput-validated finite nonzero vector; scale first to keep float4 cosine safe. */
export function unitQueryVector(vector: readonly number[]): string {
  const scale = Math.max(...vector.map(Math.abs));
  const scaled = vector.map((n) => n / scale),
    norm = Math.hypot(...scaled);
  return "[" + scaled.map((n) => n / norm).join(",") + "]";
}
