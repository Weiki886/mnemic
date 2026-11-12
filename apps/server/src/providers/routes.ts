import { registerProviderRerankerRoutes } from "./reranker-routes.js";
import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { CreateProviderSchema as CreateBody } from "../contracts/providers.js";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { createProvider, listProviders } from "./repository.js";

/**
 * Providers 配置 API（#14，ADR-005 配置单源：Web/CLI 共享这一套）。
 * 铁律：任何响应不得包含 Key 明文或密文（掩码视图由仓储层保证）。
 * 全局 Bearer 鉴权和限流在 app 的 onRequest 阶段执行。
 */

export function registerProviderRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  masterKey: Buffer,
): void {
  registerProviderRerankerRoutes(app, db, masterKey);
  app.post("/providers", async (request, reply) => {
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .header("content-type", "application/problem+json")
        .send(
          problem({
            status: 400,
            code: ErrorCode.VALIDATION_FAILED,
            detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
            errors: zodIssues(parsed.error),
            requestId: request.id,
          }),
        );
    }
    const { base_url, api_key, ...rest } = parsed.data;
    try {
      const created = await createProvider(db, masterKey, {
        ...rest,
        baseUrl: base_url,
        apiKey: api_key,
      });
      return reply.code(201).send(created);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply
          .code(409)
          .header("content-type", "application/problem+json")
          .send(
            problem({
              status: 409,
              code: ErrorCode.CONFLICT,
              detail: `Provider 名称已存在：${parsed.data.name}`,
              requestId: request.id,
            }),
          );
      }
      throw err;
    }
  });

  app.get("/providers", async () => {
    return listProviders(db, masterKey);
  });
}
