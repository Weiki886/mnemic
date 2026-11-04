import type { FastifyInstance } from "fastify";
import { DOCS_PATH, OPENAPI_PATH } from "./paths.js";
import { loadDocumentation } from "./render.js";

let snapshot: ReturnType<typeof loadDocumentation> | undefined;

export function registerDocumentationRoutes(app: FastifyInstance): void {
  app.register(async (docs) => {
    // One immutable checked-artifact snapshot per process; no per-request disk or data access.
    snapshot ??= loadDocumentation();
    const assets = await snapshot;
    docs.addHook("onSend", async (_request, reply) => {
      reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
    });
    docs.get(DOCS_PATH, async (_request, reply) =>
      reply.type("text/html; charset=utf-8").send(assets.html),
    );
    docs.get(OPENAPI_PATH, async (_request, reply) =>
      reply.type("application/json; charset=utf-8").send(assets.json),
    );
  });
}
