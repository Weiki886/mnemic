import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import {
  UsageQuerySchema,
  UsageExportQuerySchema,
  UsageReportSchema,
  UsageExportPageSchema,
} from "@mnemic/shared/usage";
import { UsageParamsSchema } from "../src/contracts/usage.js";

export function registerUsagePaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const report = registry.register("UsageReport", UsageReportSchema);
  const page = registry.register("UsageExportPage", UsageExportPageSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error("Invalid strict query, project UUID or time window; structured field errors."),
    401: error("Global operator Bearer required before validation or database access."),
    404: error(
      "Project/conversation not in scope; export cursor outside selection; or route absent without DB.",
    ),
    429: error("HTTP IP or authenticated-token request budget exhausted.", true),
    500: error("Database, preparation or export audit failure; raw errors are not returned."),
  };
  const params = UsageParamsSchema.extend({
    projectId: UsageParamsSchema.shape.projectId.openapi({
      param: { example: "01900000-0000-7000-8000-000000000001" },
    }),
  });
  const examples = {
    from: UsageQuerySchema.shape.from.openapi({ param: { example: "2026-10-01T00:00:00Z" } }),
    to: UsageQuerySchema.shape.to.openapi({ param: { example: "2026-10-04T00:00:00Z" } }),
  };
  const window =
    "Strict query: unknown fields and duplicate scalar fields rejected. Project/conversation UUIDs normalized to lowercase. ISO offset times require UTC years 0001-9999 and at most millisecond filter precision; runtime refinements enforce a positive window of at most 366 days. Defaults: to=server now, from=to minus 30 days. Half-open [from,to), UTC day grouping. Not all date refinements or cross-field limits are expressed by OpenAPI. Requires database, not master key. Global operator authorization, not project membership. Optional conversation_id means physical owning conversation; inherited continuation history is not recounted. Null-project probes excluded. No Provider resolution or model invocation; reads existing usage only. Provider/model labels are stored metadata, not guaranteed secret-redacted. Token totals and duration_ms are exact decimal strings; call and missing-call counts are bounded integers. Missing token coverage is not zero. Configured estimates use current pricing revision and historical effective rates; not provider bills or proof of billing stopped. Handler responses no-store; earlier auth/transport errors follow their own rules.";
  const successHeaders = headers.extend({ "Cache-Control": z.literal("no-store") });
  registry.registerPath({
    method: "get",
    path: "/projects/{projectId}/usage",
    operationId: "readUsageReport",
    tags: ["Usage"],
    summary: "Aggregate recorded project model usage without invoking models",
    description:
      window +
      " group_by defaults to day (also model, purpose, conversation). group_limit defaults to 200, max 1000; groups_truncated refers only to group details, totals remain complete in one SQL snapshot. Missing prices yield currency/pricing_revision/known_amount=null; a zero known subtotal does not prove free usage. Reading a report does not write an export audit.",
    request: { params, query: UsageQuerySchema.extend(examples) },
    responses: {
      ...common,
      200: {
        description:
          "Exact recorded counts, missing coverage and optional estimates, grouped within the requested scope.",
        headers: successHeaders,
        content: { "application/json": { schema: report } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/projects/{projectId}/usage/export",
    operationId: "exportUsage",
    tags: ["Usage"],
    summary: "Prepare one bounded JSON or CSV usage page and persist its audit receipt",
    description:
      window +
      " format query selects json (default) or csv, not the Accept header. limit defaults to 200, max 1000. after is an existing usage row UUID in the same project/conversation/window, otherwise 404. Keyset order (started_at,id) preserves PostgreSQL microseconds; reuse the returned exact from/to for subsequent pages, including when defaults were used. Each request is a separate DB transaction, not a frozen multi-page export snapshot. JSON returns records and next_after (null at end); CSV quotes all cells, doubles quotes, uses CRLF, prefixes potential spreadsheet formulas with an apostrophe and leaves null cells empty. CSV is an attachment, not JSON; it lacks a JSON envelope. X-Usage-From/To carry resolved bounds, optional X-Next-After is absent on the final page. Prepare the complete page and commit a minimal usage.export/prepared audit before sending; prepared does not mean delivered or saved by client. Audit failure returns fixed 500 with no export payload or committed receipt; lost response does not prove audit absent. Each successful page, including empty pages, writes a receipt; no automatic retry. Estimates have 12 fractional digits and exact token strings may exceed JavaScript safe integer precision.",
    request: {
      params,
      query: UsageExportQuerySchema.extend({
        ...examples,
        format: UsageExportQuerySchema.shape.format.openapi({ param: { example: "json" } }),
        limit: UsageExportQuerySchema.shape.limit.openapi({ param: { example: 2 } }),
      }),
    },
    responses: {
      ...common,
      200: {
        description: "One prepared page; Content-Type follows query format. No delivery guarantee.",
        headers: successHeaders.extend({
          "X-Usage-From": z.string().datetime({ offset: true }),
          "X-Usage-To": z.string().datetime({ offset: true }),
          "X-Next-After": z.string().uuid().optional(),
          "Content-Disposition": z
            .string()
            .optional()
            .openapi({ description: 'Present for CSV only: attachment; filename="usage.csv".' }),
          "Access-Control-Expose-Headers": z.string().openapi({
            description:
              "X-Next-After, X-Usage-From, X-Usage-To; usable by browser only with allowed CORS origin.",
          }),
        }),
        content: { "application/json": { schema: page }, "text/csv": { schema: z.string() } },
      },
    },
  });
}
