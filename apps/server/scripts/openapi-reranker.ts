import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import {
  ProviderRerankerCreateSchema,
  ProviderRerankerUpdateSchema,
  ProviderRerankerViewSchema,
  ProviderRerankerUpdateResultSchema,
} from "@mnemic/shared/management";
import { RerankerParamsSchema, RerankerQuerySchema } from "../src/providers/reranker-routes.js";
export function registerProviderRerankerPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema),
    view = registry.register("ProviderRerankerView", ProviderRerankerViewSchema),
    result = registry.register("ProviderRerankerUpdateResult", ProviderRerankerUpdateResultSchema);
  const headers = z.object({ "x-request-id": z.string(), "Cache-Control": z.literal("no-store") });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string() }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    401: error("Global operator Bearer required before JSON parsing/DB access."),
    404: error("Provider missing, or DB/master key route dependencies absent."),
    429: error("HTTP IP or token request budget exhausted.", true),
    500: error("Database, audit or corrupt state failure; raw internal errors are not returned."),
  };
  const json = {
    413: error("Body exceeds Fastify request limit."),
    415: error("Requires application/json, optional charset accepted before parsing."),
  };
  const success = (schema: z.ZodTypeAny, description: string) => ({
    description,
    headers,
    content: { "application/json": { schema } },
  });
  const context =
    "Operator-global Provider capability, not project membership or a fourth model slot. No probe, SDK/model call, quota reservation or model_usage write. Does not enable reranker feature flags. Requires DB+master key to register routes. Root-relative endpoint_path replaces pathname of current Provider base_url while retaining origin; only ASCII segments and final score allowed. HTTP allowed only for loopback, HTTPS otherwise; URL credentials/query/fragment/control characters rejected. Shared encrypted Provider key reused by server-only resolver; response contains neither key nor mask nor derived base URL. Handler and transport responses no-store; auth errors use root auth policy. ";
  registry.registerPath({
    method: "post",
    path: "/v1/providers/reranker",
    operationId: "createRerankerProvider",
    tags: ["Providers"],
    summary: "Register a Score-only Provider capability",
    description:
      context +
      "Creates models={} without assigning chat/extraction/embedding. Name is trimmed; API key visible ASCII8..4096 stored AES-GCM. Config and metadata-only audit commit atomically; duplicate name409. All input objects strict.",
    request: {
      query: RerankerQuerySchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: ProviderRerankerCreateSchema.extend({
              api_key: ProviderRerankerCreateSchema.shape.api_key.openapi({ writeOnly: true }),
            }),
            example: {
              name: "offline-score-example",
              base_url: "https://offline.invalid/v1",
              api_key: "offline-provider-reranker-key-00000000",
              config: { endpoint_path: "/score", timeout_ms: 5000 },
            },
          },
        },
      },
    },
    responses: {
      ...common,
      ...json,
      400: error(
        "Strict query/body or unsafe derived endpoint validation failed; structured fields when available.",
      ),
      409: error("Provider name already exists."),
      201: success(view, "New fixed-model capability, revision0."),
    },
  });
  const path = "/v1/providers/{id}/reranker";
  registry.registerPath({
    method: "get",
    path,
    operationId: "readProviderRerankerConfig",
    tags: ["Providers"],
    summary: "Read Provider reranker capability metadata",
    description:
      context +
      "Existing Providers default to revision0/config=null. Metadata reads do not decrypt keys. Invalid persisted state fails closed500.",
    request: { params: RerankerParamsSchema, query: RerankerQuerySchema },
    responses: {
      ...common,
      400: error("Invalid Provider UUID or unknown query fields; no request body is required."),
      200: success(view, "Canonical capability metadata; null config disables it."),
    },
  });
  registry.registerPath({
    method: "put",
    path,
    operationId: "updateProviderRerankerConfig",
    tags: ["Providers"],
    summary: "Compare-and-set Provider reranker capability",
    description:
      context +
      "expected_revision required. Locks Provider row before CAS; stale/exhausted409; identical content unchanged without audit/revision increment. Changed config and revision+1 plus audit share a transaction. null disables even if current base_url is unsafe. Credentials/model fields forbidden. Other later Provider edits are revalidated during resolution. Maximum revision9007199254740991.",
    request: {
      params: RerankerParamsSchema,
      query: RerankerQuerySchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: ProviderRerankerUpdateSchema,
            example: {
              expected_revision: 0,
              config: { endpoint_path: "/v1/score", timeout_ms: 1000 },
            },
          },
        },
      },
    },
    responses: {
      ...common,
      ...json,
      400: error(
        "Strict query/body/UUID or current Provider endpoint validation failed; malformed JSON400.",
      ),
      409: error(
        "Revision mismatch or exhausted; refresh metadata. Same-content request at maximum remains unchanged.",
      ),
      200: success(result, "Updated with incremented revision, or unchanged at existing revision."),
    },
  });
}
