import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import { BeliefListSchema } from "@mnemic/shared/memory";
import {
  BeliefListQuerySchema,
  BeliefParamsSchema,
  ProjectParamsSchema,
  CorrectBodySchema,
  BeliefDetailSchema,
  BeliefVersionSchema,
  BeliefStatusResultSchema,
  CorrectResultSchema,
  ResolutionTraceSchema,
} from "../src/contracts/memory.js";

/** Protocol metadata only; fields and existing input defaults come from runtime Zod. */
export function registerMemoryPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const version = registry.register("BeliefVersion", BeliefVersionSchema);
  const list = registry.register("BeliefList", BeliefListSchema);
  const detail = registry.register(
    "BeliefDetail",
    BeliefDetailSchema.extend({ versions: z.array(version) }),
  );
  const corrected = registry.register("CorrectResult", CorrectResultSchema);
  const traces = registry.register("ResolutionHistory", z.array(ResolutionTraceSchema));
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error("Invalid UUID path, query, or body. Structured field errors when available."),
    401: error("Global operator Bearer authentication required before parsing or data access."),
    429: error("IP or authenticated-token request budget exhausted.", true),
    500: error("Server/database failure. No internal exception details returned."),
  };
  const scoped = {
    ...common,
    404: error("Belief missing or belongs to a different project; same response."),
  };
  const base = "/projects/{projectId}/beliefs/{id}";
  registry.registerPath({
    method: "get",
    path: "/projects/{projectId}/beliefs",
    operationId: "listBeliefs",
    tags: ["Memory"],
    summary: "List project beliefs with filters and offset pagination",
    description:
      "Operator scope, not per-user ownership. Unknown query keys are ignored. Default status active, server limit 200 (max 1000), offset 0. q is literal case-insensitive subject/attribute containment, not value search. Missing projects return an empty list. Order is subject then attribute; offset pages are not a stable snapshot during concurrent changes. No model calls.",
    request: { params: ProjectParamsSchema, query: BeliefListQuerySchema },
    responses: {
      ...common,
      200: {
        description: "Current values with numeric scores; missing source type is null.",
        headers,
        content: { "application/json": { schema: list } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: base,
    operationId: "getBelief",
    tags: ["Memory"],
    summary: "Read belief and complete version timeline",
    description:
      "Includes soft-deleted/retracted beliefs. Arbitrary JSON values and historical null fields are preserved. Versions ordered by recorded_from. Source anchors are references, not copied source text. Query keys are ignored. No model calls.",
    request: { params: BeliefParamsSchema },
    responses: {
      ...scoped,
      200: {
        description: "Current value and full unpaginated version history.",
        headers,
        content: { "application/json": { schema: detail } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: base + "/resolutions",
    operationId: "listBeliefResolutions",
    tags: ["Memory"],
    summary: "Read belief resolution decisions",
    description:
      "Full unpaginated history ordered by createdAt, with existing camelCase keys. relation is one of four conflict relations or null (ignore/retract decisions are in policies). Historical flagsSnapshot is null, never fabricated from current configuration. Query keys are ignored. No model calls.",
    request: { params: BeliefParamsSchema },
    responses: {
      ...scoped,
      200: {
        description: "Resolution traces, including nullable model/config snapshots.",
        headers,
        content: { "application/json": { schema: traces } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: base + "/correct",
    operationId: "correctBelief",
    tags: ["Memory"],
    summary: "Correct a belief with user-correction authority",
    description:
      "Synchronous standard ingest/resolver path with USER_CORRECTION provenance. Deleted beliefs must be explicitly restored first (409); retracted beliefs may be revived. Body requires a nonempty string; unknown keys are stripped, whitespace is not trimmed. Query keys ignored. No extraction or embedding model call. This does not provide write-side secret detection; do not submit credentials as corrections.",
    request: {
      params: BeliefParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": { schema: CorrectBodySchema, example: { value: "SQLite" } },
        },
      },
    },
    responses: {
      ...scoped,
      200: {
        description:
          "Ingest route and nullable four-state relation, not the updated detail object.",
        headers,
        content: { "application/json": { schema: corrected } },
      },
      409: error("Belief deleted; restore it before correction."),
      413: error("Request body exceeds the server limit."),
      415: error("Unsupported request content type."),
    },
  });
  for (const [action, from, to] of [
    ["delete", "active", "deleted"],
    ["restore", "deleted", "active"],
  ] as const) {
    const status = registry.register(
      action === "delete" ? "BeliefDeleted" : "BeliefRestored",
      BeliefStatusResultSchema.extend({ status: z.literal(to) }),
    );
    registry.registerPath({
      method: "post",
      path: base + "/" + action,
      operationId: action === "delete" ? "softDeleteBelief" : "restoreBelief",
      tags: ["Memory"],
      summary: action === "delete" ? "Soft-delete active belief" : "Restore deleted belief",
      description: `Atomic ${from} → ${to} transition with same-transaction audit. No required body; query keys ignored. No hard deletion or propagation. A repeated request returns 409. No model calls.`,
      request: { params: BeliefParamsSchema },
      responses: {
        ...scoped,
        200: {
          description: `Transition committed.`,
          headers,
          content: { "application/json": { schema: status } },
        },
        409: error(`Only ${from} beliefs can transition to ${to}.`),
        413: error("Optional request body exceeds the server limit."),
        415: error("Unsupported optional request content type."),
      },
    });
  }
}
