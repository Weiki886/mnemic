import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import {
  ApprovalAuditEventSchema,
  ApprovalAuditQuerySchema,
  ApprovalAuditRecordSchema,
  ApprovalAuditPageSchema,
} from "@mnemic/shared/approval-audit";
import { ApprovalParamsSchema } from "../src/contracts/approval.js";

export function registerApprovalPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const event = registry.register("ApprovalAuditEvent", ApprovalAuditEventSchema);
  const record = registry.register("ApprovalAuditRecord", ApprovalAuditRecordSchema);
  const page = registry.register("ApprovalAuditPage", ApprovalAuditPageSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const successHeaders = headers.extend({ "Cache-Control": z.literal("no-store") });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error(
      "Invalid UUID, event, strict query or malformed JSON; schema errors include field details.",
    ),
    401: error(
      "Global operator Bearer required before body parsing, validation or database access.",
    ),
    404: error("Project absent, event project differs from URL scope, or route absent without DB."),
    429: error("HTTP IP or authenticated-token request budget exhausted.", true),
    500: error(
      "Database or incompatible stored record; fixed error without raw metadata or exception.",
    ),
  };
  const params = ApprovalParamsSchema.extend({
    projectId: ApprovalParamsSchema.shape.projectId.openapi({
      param: { example: "01900000-0000-7000-8000-000000000001" },
    }),
  });
  const scope =
    "Requires database, not master key. Global operator Bearer, not per-user membership authorization. URL project must exist. UUID inputs normalize to lowercase. No Provider resolution, model invocation, permission mutation or tool execution. Client-reported decisions are not server authorization or evidence of execution. Ordinary configured CORS applies; not a CLI-only Origin rejection. Handler responses no-store, earlier auth/transport errors follow their own rules.";
  registry.registerPath({
    method: "post",
    path: "/projects/{projectId}/approvals",
    operationId: "recordApprovalDecision",
    tags: ["Approvals"],
    summary: "Persist a client-reported approval decision and return an audit receipt",
    description:
      scope +
      " Strict JSON event body: unknown/plaintext command/path fields rejected. Body project_id must match URL project or 404 before insert. Query fields ignored. event.request_id is a client correlation UUID, independent of the HTTP x-request-id. Root/target/command SHA256 hashes are supplied by client; server cannot verify local filesystem or whether an operation ran. Allow/deny reason, operation, mode, scope, target_basis and command_hash combinations are runtime refinements, not fully encoded in OpenAPI. Null operation is allowed for denied invalid requests; shell requires command_hash and non-shell forbids it. Writes audit_log actor=cli, version=1/client_reported=true, action=approval.<operation or invalid>, target=sha256:<target_hash> or null, decision=allow/deny. First event_id insert returns201. Same normalized event under same ID returns200 with original recorded_at, without new row; different event or incompatible/colliding platform history returns409 without overwriting. Global event-ID collision does not reveal the existing payload. A lost response may follow a committed insert: if deliberately retrying the audit receipt, retain the identical event_id and payload, never regenerate it or repeat the underlying tool operation. No additional execution, rollback or cross-service exactly-once guarantee.",
    request: {
      params,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: event,
            example: {
              event_id: "01900000-0000-7000-8000-000000000002",
              request_id: "01900000-0000-7000-8000-000000000003",
              project_id: "01900000-0000-7000-8000-000000000001",
              session_id: "01900000-0000-7000-8000-000000000004",
              mode: "confirm",
              operation: "file.create",
              decision: "allow",
              reason: "confirmed",
              scope: "once",
              root_hash: "a".repeat(64),
              target_hash: "b".repeat(64),
              target_basis: "canonical",
            },
          },
        },
      },
    },
    responses: {
      ...common,
      200: {
        description: "Identical event already recorded; original receipt, not a new decision.",
        headers: successHeaders,
        content: { "application/json": { schema: record } },
      },
      201: {
        description: "New client-reported audit row persisted; no tool execution implied.",
        headers: successHeaders,
        content: { "application/json": { schema: record } },
      },
      409: error(
        "Event ID is already used for another event or an incompatible row; existing row unchanged.",
      ),
      413: error("Supplied body exceeds the server limit."),
      415: error(
        "Supplied media type is unsupported. Supported text/plain parses but fails object validation as400.",
      ),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/projects/{projectId}/approvals",
    operationId: "listApprovalDecisions",
    tags: ["Approvals"],
    summary: "Read client-reported project decision receipts in stable timestamp and ID order",
    description:
      scope +
      " Strict query with limit default50 (1..200), offset default0 (0..MAX_SAFE_INTEGER). Decimal digit strings including leading zeros or direct numbers accepted by runtime schema; blank, fractional, exponential, negative strings and unsafe integers rejected. Runtime numeric refinements are not fully represented by the generated query anyOf. Reads actor=cli/action approval.% plus matching meta.project_id/client_reported=true/version=1; excludes other platform/redaction events. Orders by stored (ts,id) ascending and returns items/limit/offset, no total or next cursor. recorded_at is server persistence time serialized at JS millisecond precision, not client decision time. Each page is a separate query, not a frozen snapshot. If a selected historical row fails event schema or envelope consistency, the entire page returns fixed500; it is not silently omitted. Hashes and IDs remain metadata, not proof of local permissions or execution.",
    request: {
      params,
      query: ApprovalAuditQuerySchema.extend({
        limit: ApprovalAuditQuerySchema.shape.limit.openapi({ param: { example: 2 } }),
      }),
    },
    responses: {
      ...common,
      200: {
        description:
          "Project-local compatible client reports, with normalized pagination; empty items when none.",
        headers: successHeaders,
        content: { "application/json": { schema: page } },
      },
    },
  });
}
