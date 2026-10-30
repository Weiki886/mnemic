import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import {
  DEFAULT_FEATURE_FLAGS,
  FeatureFlagSnapshotSchema,
  FeatureFlagUpdateSchema,
  FeatureFlagHttpUpdateResultSchema,
} from "@mnemic/shared/flags";
import { HealthResponseSchema } from "../src/contracts/health.js";
import { UNSUPPORTED_FEATURE_FLAGS } from "../src/flags/runtime.js";
extendZodWithOpenApi(z);
const artifact = new URL("../../../docs/openapi.json", import.meta.url);
export type OpenApiDocument = ReturnType<OpenApiGeneratorV3["generateDocument"]>;
export function createOpenApiDocument(): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const health = registry.register("HealthResponse", HealthResponseSchema);
  const snapshot = registry.register("FeatureFlagSnapshot", FeatureFlagSnapshotSchema);
  const update = registry.register("FeatureFlagUpdate", FeatureFlagUpdateSchema);
  const updated = registry.register("FeatureFlagUpdateResult", FeatureFlagHttpUpdateResultSchema);
  const headers = z.object({
    "x-request-id": z
      .string()
      .openapi({ description: "Server request identifier, also present in problem bodies." }),
  });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry
      ? headers.extend({
          "Retry-After": z
            .string()
            .regex(/^[1-9]\d*$/)
            .openapi({
              description:
                "Minimum suggested wait in seconds; competing traffic can consume replenished capacity.",
            }),
        })
      : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error("Invalid request or query parameters."),
    401: error("Bearer authentication is required before parsing JSON or accessing data."),
    429: error("IP or authenticated-token request budget exhausted. No automatic retry.", true),
    500: error("Database or server failure. Internal payloads are not returned."),
  };
  registry.registerPath({
    method: "get",
    path: "/health",
    operationId: "getHealth",
    tags: ["System"],
    summary: "Check HTTP service liveness",
    description:
      "Public liveness only; this does not prove database, model or deployment readiness. Query parameters are ignored.",
    security: [],
    responses: {
      200: {
        description: "HTTP process is responding.",
        headers,
        content: { "application/json": { schema: health, example: { status: "ok" } } },
      },
    },
  });
  registry.registerPath({
    method: "head",
    path: "/health",
    operationId: "headHealth",
    tags: ["System"],
    summary: "Check liveness without a response body",
    description: "Same public liveness check as GET; the response body is empty.",
    security: [],
    responses: { 200: { description: "HTTP process is responding; no response body.", headers } },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/config/flags",
    operationId: "getFeatureFlags",
    tags: ["Configuration"],
    summary: "Read persisted feature flag configuration",
    description:
      "Global operator scope. No query parameters accepted. Returns persisted flags rather than effective per-operation overrides; no model invocation. Cache-Control: no-store.",
    responses: {
      ...common,
      200: {
        description:
          "Strict persisted snapshot; historical or unsupported true values may be read for operator repair.",
        headers,
        content: {
          "application/json": {
            schema: snapshot,
            example: { schema_version: 1, revision: 0, flags: DEFAULT_FEATURE_FLAGS },
          },
        },
      },
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/config/flags",
    operationId: "replaceFeatureFlags",
    tags: ["Configuration"],
    summary: "Replace all feature flags with revision checking",
    description: `JSON-only full replacement, no query parameters. Audit and update are atomic; unchanged flags do not increase revision or write an audit. Unsupported true flags (${UNSUPPORTED_FEATURE_FLAGS.join(", ")}) return 400 before database access even though their syntactic type is boolean. Cache-Control: no-store.`,
    request: {
      body: {
        required: true,
        description:
          "Use the current revision from GET. This offline example assumes a fresh revision=0 snapshot; otherwise refresh and deliberately choose a new full replacement.",
        content: {
          "application/json": {
            schema: update,
            example: {
              expected_revision: 0,
              flags: { ...DEFAULT_FEATURE_FLAGS, memory_gate: false },
            },
          },
        },
      },
    },
    responses: {
      ...common,
      200: {
        description: "Updated or unchanged snapshot; no model invocation.",
        headers,
        content: { "application/json": { schema: updated } },
      },
      409: error(
        "Revision mismatch or exhausted revision. Read current configuration before a deliberate retry.",
      ),
      415: error("Content-Type must be application/json, optionally with charset."),
    },
  });
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Mnemic API — contract foundation",
      version: "0.1.0",
      description:
        "Partial contract for health and feature flag management only (Issue #24 split 1/3). Other implemented APIs and the online documentation page are not included yet. Error type URIs are stable identifiers, not guaranteed live web pages.",
    },
    servers: [
      {
        url: "http://127.0.0.1:3000",
        description: "Local development example; configure host/port separately.",
      },
    ],
    tags: [
      { name: "System", description: "Process liveness." },
      { name: "Configuration", description: "Global operator feature flag configuration." },
    ],
    security: [{ bearerAuth: [] }],
  });
}
export async function serializeOpenApi(doc: OpenApiDocument = createOpenApiDocument()) {
  // Existing repository formatter is a root dev dependency; generation is a workspace-only build tool.
  return format(JSON.stringify(doc), { parser: "json", printWidth: 100 });
}
export async function checkOpenApiArtifact(text: string) {
  if (text !== (await serializeOpenApi()))
    throw Error(
      "OpenAPI artifact is out of date; run pnpm --filter @mnemic/server openapi:generate",
    );
}
export async function runOpenApiCommand(args: string[]) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw Error("OpenAPI command only accepts --check or no arguments");
  if (args[0] === "--check") await checkOpenApiArtifact(await readFile(artifact, "utf8"));
  else await writeFile(artifact, await serializeOpenApi());
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runOpenApiCommand(process.argv.slice(2));
    console.info("OpenAPI artifact verified/generated");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OpenAPI generation failed");
    process.exitCode = 1;
  }
}
