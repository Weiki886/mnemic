import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import { MemoryExportRequestSchema } from "../src/contracts/data-export.js";

export function registerMemoryExportPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const input = registry.register("MemoryExportRequest", MemoryExportRequestSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/exports/memory",
    operationId: "exportInstanceMemory",
    tags: ["Data export"],
    summary: "Prepare a bounded lossless whole-instance core-table JSONL archive",
    description:
      "Requires DB and global operator Bearer, not master key or per-project membership. Explicit scope=instance acknowledges ALL projects, conversations/messages, observations, beliefs, ALL belief_versions, memory_embeddings and raw audit_log, including sensitive/unknown historical JSONB. No project/table/query filter; unknown body and query fields rejected. Never contains provider_configs or later module tables; not a whole-database backup. One repeatable-read transaction reads rows in fixed table and UUID order in pages of8; deleted/retracted facts and inherited reference metadata remain unchanged. to_jsonb(row)::text is stored as row_json STRING to preserve numeric lexemes and microsecond timestamps; clients must not parse/reserialize through lossy JS numbers. UTF8 LF JSONL manifest/row/end format v1, trailing LF required, eight table counts and SHA256 over manifest+row bytes including LF, excluding end. Hash detects corruption, not authenticity/encryption. Fixed bounds10000rows,1MiB per encoded line,16MiB entire archive including footer; any overflow rejects the whole export, never truncates. Oversized raw rows suppressed by SQL before transfer; SQL pages<=8 rows; each query5s and lock wait1s. No hard whole-process memory/CPU guarantee. Archive is fully encoded before audit_log actor=server/action=memory.export/target=export_id/decision=prepared with counts/bytes/hash only, in same transaction. Transaction commit must succeed before any download bytes/attachment header. Current receipt is excluded from its own earlier snapshot, previous audit rows are included. prepared proves payload preparation and audit commit, NOT client delivery or disk persistence; lost responses may still leave receipts and manual retry creates another export. No importer, file write, model call, data mutation except audit. No redaction/encryption: protect transport and downloaded file. GET is not an export route. Handler hook sets no-store after root auth/rate; earlier transport errors keep existing rules. Ordinary configured CORS applies.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: input, example: { scope: "instance" } } },
      },
    },
    responses: {
      200: {
        description:
          "Complete sensitive JSONL archive; never a partial snapshot or full-instance SQL backup.",
        headers: headers.extend({
          "Cache-Control": z.literal("no-store"),
          "Content-Disposition": z
            .string()
            .regex(/^attachment; filename="mnemic-memory-[0-9a-f-]+\.jsonl"$/),
          "X-Content-Type-Options": z.literal("nosniff"),
        }),
        content: {
          "application/x-ndjson": {
            schema: z.string().openapi({
              format: "binary",
              description:
                "UTF8 JSONL v1; see docs/data-export.md for framing and raw row_json precision.",
            }),
          },
        },
      },
      400: error(
        "Invalid explicit scope/body, unknown query fields or malformed JSON; schema failures carry field errors.",
      ),
      401: error("Global operator Bearer required before parsing, media validation or DB access."),
      404: error("Route unavailable without database, or unsupported method/path."),
      413: error(
        "Request body exceeds HTTP limit, or archive exceeds fixed row/line/file limit. No prepared receipt or partial archive.",
      ),
      415: error(
        "Requires application/json, optional charset parameter; other/missing media rejected before parsing.",
      ),
      429: error("Root IP/token request budget exhausted before preparation.", true),
      500: error(
        "Snapshot, codec or audit failure. No archive returned, fixed detail and no raw exception or row data. A connection loss around COMMIT can leave a prepared receipt.",
      ),
    },
  });
}
