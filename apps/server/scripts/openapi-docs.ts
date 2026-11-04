import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import { DOCS_PATH, OPENAPI_PATH } from "../src/docs/paths.js";

export function registerDocumentationPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const artifact = registry.register(
    "OpenApiArtifact",
    z
      .object({
        openapi: z.literal("3.0.3"),
        info: z.record(z.unknown()),
        paths: z.record(z.unknown()),
      })
      .passthrough(),
  );
  const common = z.object({ "x-request-id": z.string() });
  const headers = common.extend({
    "Cache-Control": z.literal("no-store"),
    "X-Content-Type-Options": z.literal("nosniff"),
    "Referrer-Policy": z.literal("no-referrer"),
    "Content-Security-Policy": z.string(),
  });
  for (const path of [DOCS_PATH, OPENAPI_PATH])
    for (const method of ["get", "head"] as const) {
      const page = path === DOCS_PATH;
      registry.registerPath({
        method,
        path,
        operationId: `${method}${page ? "ApiDocumentation" : "OpenApiArtifact"}`,
        tags: ["Documentation"],
        security: [],
        summary: `${method === "head" ? "Inspect headers of" : "Read"} ${page ? "the offline API reference" : "the checked OpenAPI document"}`,
        description:
          "Public read-only static contract metadata, not live instance configuration or data. Only exact GET/HEAD paths exempt Bearer; IP admission still applies, authenticated-token budget does not. Query/header values ignored and never embedded. No token input, interactive API execution, model, database or network/CDN dependency. HTML contains native operation/schema disclosures and all contract examples; the JSON endpoint returns exact checked-artifact bytes. Source and compiled workspace/container use the same packaged artifact; one boot snapshot per process, restart after regenerating. Missing/corrupt artifact fails startup with a fixed error, not a partial page. Contract describes supported interfaces, not runtime availability/readiness. Complete integration guide remains a separate delivery. Successful responses no-store/nosniff/no-referrer, HTML has restrictive no-script/frame/form CSP. The relative download link works directly and behind the existing /api prefix. No automatic requests, retries or billable probes.",
        responses: {
          200:
            method === "head"
              ? { description: "Same static response headers as GET; empty body.", headers }
              : {
                  description: page
                    ? "Complete read-only HTML reference generated from the artifact, with no executable code or credential fields."
                    : "Exact submitted OpenAPI3.0.3 document, not a filtered runtime capability report.",
                  headers,
                  content: page
                    ? { "text/html": { schema: z.string() } }
                    : {
                        "application/json": {
                          schema: artifact,
                        },
                      },
                },
          429: {
            description:
              "IP request budget exhausted; wait according to Retry-After. HEAD has no body.",
            headers: common.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }),
            ...(method === "get"
              ? { content: { "application/problem+json": { schema: problem } } }
              : {}),
          },
        },
      });
    }
}
