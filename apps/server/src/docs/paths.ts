import type { FastifyRequest } from "fastify";

export const DOCS_PATH = "/docs";
export const OPENAPI_PATH = "/docs/openapi.json";

/** Only static documentation; separate from full transport/budget exemptions. */
export function isPublicDocumentationRequest(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = request.raw.url?.split("?")[0];
  return path === DOCS_PATH || path === OPENAPI_PATH;
}
