import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import { AuditQuerySchema, AuditLogPageSchema } from "../src/contracts/audit.js";

export function registerAuditPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const page = registry.register("AuditLogPage", AuditLogPageSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/audit-log",
    operationId: "readPlatformAuditLog",
    tags: ["Audit"],
    summary: "Read safe projections of global operator audit history",
    description:
      "Requires DB, not master key; route absent without DB. Global Bearer operator authorization, not per-project membership. Strict query, unknown/duplicate scalar fields rejected. UUID filters normalize lowercase; actor/action/target are allowlisted forms. project_id only compares meta.project_id as a string; it does not check project existence or include global events without that metadata (such as Provider/flags events). This is a filter, never an access boundary. Defaults: to=server now, from=to minus30 days; half-open [from,to), positive span at most366 days. Filter dates require UTC years0001-9999 and at most millisecond precision; those refinements are runtime checks. limit default50, 1..200; digit strings accepted, fractions/exponents/blanks rejected. Keyset order (ts,id), cursor must exist inside the same filters/window or404. Cursor timestamp read as PG raw text preserves microseconds; output ts also has microseconds. Reuse resolved from/to across pages; each page is a separate query, not a frozen snapshot. Unknown/corrupt/oversized (>65536 UTF8 bytes of meta::text) or envelope-inconsistent rows remain opaque history positions: id/ts retained, actor/action/target/decision/meta all null, metadata_omitted=true. Actor/action/decision >64 bytes or target >128 bytes are similarly suppressed before projection. Opaque rows still count toward limit and can serve as cursors. Known metadata is projected through existing strict schemas: platform events, gate redaction summaries and client-reported approval events. Cross-field consistency uses runtime projection and is not fully encoded by OpenAPI. This differs from the project approval endpoint, which fails the whole page for selected incompatible rows. No new audit write, permission mutation, Provider resolution or model invocation. Client reports and prepared receipts are not execution/delivery proof. Route hook sets no-store after root auth/rate admission; earlier errors obey their own rules. Ordinary CORS applies. Not a backup or proof that all real-world actions were recorded.",
    request: {
      query: AuditQuerySchema.extend({
        from: AuditQuerySchema.shape.from.openapi({ param: { example: "2026-11-01T00:00:00Z" } }),
        to: AuditQuerySchema.shape.to.openapi({ param: { example: "2026-11-02T00:00:00Z" } }),
        limit: AuditQuerySchema.shape.limit.openapi({ param: { example: 2 } }),
      }),
    },
    responses: {
      200: {
        description: "One safe page including opaque history positions; next_after=null at end.",
        headers: headers.extend({ "Cache-Control": z.literal("no-store") }),
        content: { "application/json": { schema: page } },
      },
      400: error("Invalid strict filters or time window; structured field errors."),
      401: error("Operator Bearer required before query validation and database access."),
      404: error("Cursor not found inside current selection, or route unavailable without DB."),
      429: error("HTTP IP or authenticated-token request budget exhausted.", true),
      500: error("Unexpected database/server failure; fixed detail, no raw errors or metadata."),
    },
  });
}
