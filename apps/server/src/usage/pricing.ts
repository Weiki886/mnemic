import { createHash } from "node:crypto";
import { z } from "zod";
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/);
const PriceSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    rates: z
      .array(
        z
          .object({
            provider_name: z.string().min(1).max(200),
            model_id: z.string().min(1).max(200),
            slot: z.enum(["chat", "extraction", "embedding"]),
            effective_from: z.string().datetime({ offset: true }),
            input_per_million: decimal,
            output_per_million: decimal,
            cached_input_per_million: decimal.optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export interface UsagePricing {
  currency: string | null;
  rates: z.infer<typeof PriceSchema>["rates"];
  revision: string | null;
}
export function parseUsagePricing(raw: string | undefined): UsagePricing {
  if (raw === undefined) return { currency: null, rates: [], revision: null };
  try {
    if (raw.length > 100000) throw new Error();
    const data = PriceSchema.parse(JSON.parse(raw));
    const keys = data.rates.map((r) =>
      JSON.stringify([
        r.provider_name,
        r.model_id,
        r.slot,
        new Date(r.effective_from).toISOString(),
      ]),
    );
    if (new Set(keys).size !== keys.length) throw new Error();
    return { ...data, revision: createHash("sha256").update(JSON.stringify(data)).digest("hex") };
  } catch {
    throw new Error("MNEMIC_USAGE_PRICES_JSON invalid");
  }
}
export function usageWindow(
  q: { from?: string | undefined; to?: string | undefined },
  now = new Date(),
) {
  const end = q.to ? new Date(q.to) : now;
  const start = q.from ? new Date(q.from) : new Date(end.getTime() - 30 * 86400000);
  const span = end.getTime() - start.getTime();
  if (!Number.isFinite(span) || span <= 0 || span > 366 * 86400000)
    throw new Error("invalid usage window");
  return { from: start.toISOString(), to: end.toISOString() };
}
