import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import {
  ConfigSchema,
  ProjectStatusSchema,
  ProviderConfigSchema,
  ProviderPatchSchema,
} from "@mnemic/shared/management";
import {
  CreateProviderSchema,
  LegacyProviderViewSchema,
  ProviderIdParamsSchema,
  ProviderProjectParamsSchema,
  StatusQuerySchema,
} from "../src/contracts/providers.js";

export function registerProviderPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const legacy = registry.register("LegacyProvider", LegacyProviderViewSchema);
  const config = registry.register("ProviderConfig", ProviderConfigSchema);
  const snapshot = registry.register("ServerConfig", ConfigSchema);
  const status = registry.register("ProjectStatus", ProjectStatusSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error("Invalid input or unsupported query; structured field errors when available."),
    401: error("Global operator Bearer required before JSON parsing and data access."),
    404: error(
      "Route is unavailable when its database/master-key dependencies are not configured.",
    ),
    429: error("IP or authenticated-token request budget exhausted.", true),
    500: error(
      "Database, decryption or server failure; internal exception details are not returned.",
    ),
  };
  const bodyErrors = {
    413: error("Request body exceeds server limit."),
    415: error("Unsupported request content type."),
  };
  registry.registerPath({
    method: "get",
    path: "/providers",
    operationId: "listProviders",
    tags: ["Providers"],
    summary: "Read legacy masked Provider views",
    description:
      "Global operator scope. Requires DB and master key; otherwise route absent. Decrypts stored keys only to build masks; never returns raw/encrypted api_key. CamelCase baseUrl/apiKeyMasked/createdAt differs from /v1/config. baseUrl and models are raw stored metadata, not sanitized or validated by this legacy read path; do not embed credentials in endpoint URLs. Full unpaginated list ordered by created_at; query keys ignored. Not a connectivity probe, no SDK/model call.",
    responses: {
      401: common[401],
      404: common[404],
      429: common[429],
      500: common[500],
      200: {
        description: "Legacy rows with masked credential strings and raw URL/models.",
        headers,
        content: { "application/json": { schema: z.array(legacy) } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/providers",
    operationId: "createProvider",
    tags: ["Providers"],
    summary: "Create encrypted Provider configuration with one or more model slots",
    description:
      "Requires DB and master key. Body extras are stripped, including unknown models keys. Strings are not trimmed; old generic URL validator remains (unlike PATCH). At least one nonempty chat/extraction/embedding model is required by runtime refinement. Key encryption, config creation and metadata-only audit share a transaction. Does not contact the endpoint, validate embedding dimensions or invoke any model. Duplicate name409. Do not submit a real credential to the offline example.",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: CreateProviderSchema.extend({
              api_key: CreateProviderSchema.shape.api_key.openapi({
                writeOnly: true,
                description: "Credential input only; encrypted at rest, never returned verbatim.",
              }),
            }),
            example: {
              name: "openapi-offline-example",
              protocol: "openai-compatible",
              base_url: "https://example.invalid/v1",
              api_key: "offline-example-key-1234",
              models: { chat: "offline-chat", extraction: "offline-extract" },
            },
          },
        },
      },
    },
    responses: {
      ...common,
      ...bodyErrors,
      409: error("Provider name already exists."),
      201: {
        description: "New legacy camelCase view, including masked key; configuration only.",
        headers,
        content: { "application/json": { schema: legacy } },
      },
    },
  });
  registry.registerPath({
    method: "patch",
    path: "/providers/{id}",
    operationId: "updateProvider",
    tags: ["Providers"],
    summary: "Patch existing Provider metadata and chat/extraction models",
    description:
      "Requires DB; never decrypts key or constructs SDK. Strict body and models reject unknown fields, api_key and embedding. At least one field and nonempty models patch required by runtime refinements. Supplied strings are trimmed; URL must be HTTP(S) without credentials/query/fragment and trailing slashes are normalized. A Provider carrying an embedding slot cannot change endpoint/protocol (409); re-embedding is not implemented here. Unchanged patches return current config without audit; actual change and metadata-only audit are atomic. Successful handler responses are no-store. Query ignored.",
    request: {
      params: ProviderIdParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: ProviderPatchSchema,
            example: {
              models: { chat: "offline-chat-updated", extraction: "offline-extract-updated" },
            },
          },
        },
      },
    },
    responses: {
      ...common,
      ...bodyErrors,
      404: error("Provider does not exist."),
      409: error("Duplicate name or endpoint/protocol change on an embedding Provider."),
      200: {
        description: "Strict snake_case safe config view, with no key or mask.",
        headers,
        content: { "application/json": { schema: config } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/config",
    operationId: "getServerConfig",
    tags: ["Configuration"],
    summary: "Read safe Provider and selected model slot snapshot",
    description:
      "DB required, master key not required. No query parameters accepted. No key decryption, SDK construction or model calls; no key/mask in response. Safe HTTP(S) endpoints strip username/password/query/fragment; other URLs become null. Invalid metadata rows are omitted from providers and their IDs reported; an invalid earliest candidate yields model=null/invalid=true, not silent fallback. Selection order created_at then id, as SDK resolution. At most1000 providers; overflow500. This snapshot is not a connectivity/readiness proof. Handler responses no-store.",
    responses: {
      ...common,
      200: {
        description: "Safe global config_source=server snapshot; missing slots are null.",
        headers,
        content: { "application/json": { schema: snapshot } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/projects/{projectId}/status",
    operationId: "getProjectStatus",
    tags: ["Configuration"],
    summary: "Read current project/conversation counts and global model slots",
    description:
      "DB required. conversation_id is required, UUID validated, query extras rejected. Conversation must belong to URL project or404, before reading global config. Counts are project-local; slots remain the global snapshot, not per-project providers. Counts total equals all six statuses (runtime refinement). No decryption, SDK construction or model calls. Handler responses no-store.",
    request: { params: ProviderProjectParamsSchema, query: StatusQuerySchema },
    responses: {
      ...common,
      404: error("Project or conversation missing, or cross-project conversation."),
      200: {
        description: "Project/conversation references, local counts and global slots.",
        headers,
        content: { "application/json": { schema: status } },
      },
    },
  });
}
