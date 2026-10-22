import { z } from "zod";
const text = z.string().trim().min(1).max(200);
export const SafeEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash
    );
  }, "端点须为不含凭据、查询或片段的 HTTP(S) URL")
  .transform((value) => new URL(value).toString().replace(/\/+$/, ""));
export const ProviderPatchSchema = z
  .object({
    name: text.max(64).optional(),
    protocol: z.enum(["openai-compatible", "anthropic"]).optional(),
    base_url: SafeEndpointSchema.optional(),
    models: z
      .object({ chat: text.optional(), extraction: text.optional() })
      .strict()
      .refine((m) => m.chat !== undefined || m.extraction !== undefined, "至少修改一个槽位")
      .optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), "修改不能为空");
export type ProviderPatch = z.infer<typeof ProviderPatchSchema>;
const models = z
  .object({ chat: text.optional(), extraction: text.optional(), embedding: text.optional() })
  .strict();
export const ProviderConfigSchema = z
  .object({
    id: z.string().uuid(),
    name: text,
    protocol: z.enum(["openai-compatible", "anthropic"]),
    base_url: SafeEndpointSchema.nullable(),
    models,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
const slot = z
  .object({ provider_id: z.string().uuid(), provider_name: text, model: text })
  .strict()
  .nullable();
export const SlotSnapshotSchema = z
  .object({ chat: slot, extraction: slot, embedding: slot })
  .strict();
export const ConfigSchema = z
  .object({
    config_source: z.literal("server"),
    providers: z.array(ProviderConfigSchema).max(1000),
    slots: SlotSnapshotSchema,
  })
  .strict();
export const ProjectStatusSchema = z
  .object({
    project: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
    conversation: z
      .object({ id: z.string().uuid(), ended_at: z.string().datetime({ offset: true }).nullable() })
      .strict(),
    counts: z
      .object({
        total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        active: z.number().int().nonnegative(),
        deleted: z.number().int().nonnegative(),
        retracted: z.number().int().nonnegative(),
        superseded: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
      })
      .strict(),
    slots: SlotSnapshotSchema,
  })
  .strict()
  .refine(
    (s) =>
      s.counts.total ===
      s.counts.active +
        s.counts.deleted +
        s.counts.retracted +
        s.counts.superseded +
        s.counts.expired,
    "计数不一致",
  );
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ServerConfig = z.infer<typeof ConfigSchema>;
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
