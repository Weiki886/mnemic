import { z } from "zod";

/** Existing legacy creation rules: strip extras, preserve whitespace and generic URLs. */
export const CreateProviderSchema = z.object({
  name: z.string().min(1).max(64),
  protocol: z.enum(["openai-compatible", "anthropic"]),
  base_url: z.string().url(),
  api_key: z.string().min(8),
  models: z
    .object({
      chat: z.string().min(1).optional(),
      extraction: z.string().min(1).optional(),
      embedding: z.string().min(1).optional(),
    })
    .refine((m) => m.chat || m.extraction || m.embedding, {
      message: "至少配置一个槽位",
    }),
});

export const ProviderIdParamsSchema = z.object({ id: z.string().uuid() });
export const ProviderProjectParamsSchema = z.object({ projectId: z.string().uuid() });
export const StatusQuerySchema = z.object({ conversation_id: z.string().uuid() }).strict();
export const ConfigQuerySchema = z.object({}).strict();

/** Legacy GET/POST view: raw stored URL/models, masked key, and camelCase fields. */
export const LegacyProviderViewSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    protocol: z.enum(["openai-compatible", "anthropic"]),
    baseUrl: z.string(),
    apiKeyMasked: z.string(),
    models: z.unknown().refine((value) => value !== undefined, "模型字段不可缺失"),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
