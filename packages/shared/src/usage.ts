import { z } from "zod";
const uuid = z.string().uuid().toLowerCase();
const date = z.string().datetime({ offset: true });
const filterDate = date.refine((s) => !/\.\d{4}/.test(s), "查询时间最多支持毫秒精度");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integer = z.string().regex(/^\d+$/);
const amount = z.string().regex(/^\d+\.\d{12}$/);
const filters = {
  conversation_id: uuid.optional(),
  from: filterDate.optional(),
  to: filterDate.optional(),
};
export const UsageQuerySchema = z
  .object({
    ...filters,
    group_by: z.enum(["day", "model", "purpose", "conversation"]).default("day"),
    group_limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();
export const UsageExportQuerySchema = z
  .object({
    ...filters,
    format: z.enum(["json", "csv"]).default("json"),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    after: uuid.optional(),
  })
  .strict();
export type UsageQuery = z.input<typeof UsageQuerySchema>;
export type UsageExportQuery = z.input<typeof UsageExportQuerySchema>;
export const UsageMetricSchema = z.object({ reported: integer, missing_calls: count }).strict();
const tokenFields = {
  prompt_tokens: UsageMetricSchema,
  completion_tokens: UsageMetricSchema,
  total_tokens: UsageMetricSchema,
  reasoning_tokens: UsageMetricSchema,
  cached_input_tokens: UsageMetricSchema,
};
export const UsageTotalsSchema = z
  .object({
    calls: count,
    success_calls: count,
    error_calls: count,
    aborted_calls: count,
    duration_ms: integer,
    ...tokenFields,
    estimated_cost: z
      .object({ known_amount: amount.nullable(), priced_calls: count, unpriced_calls: count })
      .strict(),
  })
  .strict();
const context = {
  project_id: uuid,
  conversation_id: uuid.nullable(),
  from: date,
  to: date,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  pricing_revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
};
export const UsageReportSchema = z
  .object({
    ...context,
    group_by: UsageQuerySchema.shape.group_by,
    groups_truncated: z.boolean(),
    totals: UsageTotalsSchema,
    groups: z
      .array(z.object({ key: z.record(z.string().nullable()), totals: UsageTotalsSchema }).strict())
      .max(1000),
  })
  .strict();
export const UsageRowSchema = z
  .object({
    id: uuid,
    conversation_id: uuid.nullable(),
    provider_name: z.string(),
    model_id: z.string(),
    slot: z.enum(["chat", "extraction", "embedding"]),
    purpose: z.string(),
    status: z.enum(["success", "error", "aborted"]),
    started_at: date,
    duration_ms: integer,
    prompt_tokens: integer.nullable(),
    completion_tokens: integer.nullable(),
    total_tokens: integer.nullable(),
    reasoning_tokens: integer.nullable(),
    cached_input_tokens: integer.nullable(),
    estimated_cost: amount.nullable(),
  })
  .strict();
export const UsageExportPageSchema = z
  .object({ ...context, records: z.array(UsageRowSchema).max(1000), next_after: uuid.nullable() })
  .strict();
export type UsageReport = z.infer<typeof UsageReportSchema>;
export type UsageExportPage = z.infer<typeof UsageExportPageSchema>;
export type UsageRow = z.infer<typeof UsageRowSchema>;
