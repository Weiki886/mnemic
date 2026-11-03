import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import {
  PendingListQuerySchema,
  PendingRowSchema,
  ConfirmPendingResultSchema,
  RejectPendingResultSchema,
} from "../src/contracts/pending.js";

export function registerPendingPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const row = registry.register("PendingRow", PendingRowSchema);
  const confirmed = registry.register("ConfirmPendingResult", ConfirmPendingResultSchema);
  const rejected = registry.register("RejectPendingResult", RejectPendingResultSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error(
      "Invalid query or malformed JSON; query validation includes structured field errors.",
    ),
    401: error("Global operator Bearer required before parsing or database access."),
    429: error("IP or authenticated-token HTTP request budget exhausted.", true),
    500: error("Unexpected server failure; raw database exceptions are not exposed."),
  };
  registry.registerPath({
    method: "get",
    path: "/pending",
    operationId: "listPendingCandidates",
    tags: ["Pending"],
    summary: "List stored candidates by project and status",
    description:
      "Requires DB, not master key. Global operator scope, not project membership authorization. Required project_id only filters rows; nonexistent projects return200 empty array. Optional status defaults to pending in handler. Unknown query fields (including limit/offset) are ignored. Unpaginated, createdAt ascending; ties have no guaranteed ordering. Returns camelCase stored rows, including original arbitrary JSONB candidate/gateScores (not guaranteed to match current extraction schema). Contains memory content; no route-level no-store header. TTL is stored metadata, not automatic filtering/expiration. No model invocation, state changes or promotion.",
    request: {
      query: PendingListQuerySchema.extend({
        project_id: PendingListQuerySchema.shape.project_id.openapi({
          param: { example: "01900000-0000-7000-8000-000000000001" },
        }),
      }),
    },
    responses: {
      ...common,
      404: error("Route unavailable without database configuration."),
      200: {
        description: "All matching stored candidates; empty array when none match.",
        headers,
        content: { "application/json": { schema: z.array(row) } },
      },
    },
  });
  for (const [action, schema] of [
    ["confirm", confirmed],
    ["reject", rejected],
  ] as const) {
    registry.registerPath({
      method: "post",
      path: `/pending/{id}/${action}`,
      operationId: action === "confirm" ? "confirmPendingCandidate" : "rejectPendingCandidate",
      tags: ["Pending"],
      summary: `${action === "confirm" ? "Confirm" : "Reject"} a candidate by global ID`,
      description:
        "Requires DB and global operator Bearer. Legacy global-ID operation: no project_id guard or per-project authorization; query fields ignored. No request-body schema: absent body and any valid JSON body are ignored, but Fastify still parses supplied bodies and enforces media/body limits. Any Origin follows ordinary configured CORS, unlike CLI-only probe/recall. ID has no route UUID validation: malformed UUID reaches DB and is caught as404, not a structured400. Unconditional update by ID, regardless of current status or expired TTL; repeated calls reset decidedAt, confirm and reject may overwrite one another. No CAS/precondition or409. Returns complete stored camelCase row with the requested status. Does not create Observation/Belief, enqueue extraction, invoke models or run Gate/Resolver; confirmed is not proof of promotion into retrievable memory. Emits metadata debug event only when debug is enabled; no durable decision audit is added by this route. Any repository failure is caught as404, which does not distinguish absence from failure or guarantee no update committed. No automatic retry or route-level no-store guarantee. Candidate/gateScores remain arbitrary stored JSONB.",
      request: {
        params: z.object({
          id: z.string().openapi({ param: { example: "01900000-0000-7000-8000-000000000002" } }),
        }),
      },
      responses: {
        ...common,
        404: error(
          "ID absent, malformed, route unavailable without DB, or caught repository failure.",
        ),
        413: error("Supplied body exceeds default server limit."),
        415: error("Supplied body media type is not supported by Fastify parsers."),
        200: {
          description: "Updated candidate row; not a completed memory ingestion receipt.",
          headers,
          content: { "application/json": { schema } },
        },
      },
    });
  }
}
