import type { FastifyInstance, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import {
  ProviderRerankerCreateSchema,
  ProviderRerankerUpdateSchema,
} from "@mnemic/shared/management";
import {
  createRerankerProvider,
  readProviderRerankerConfig,
  updateProviderRerankerConfig,
  ProviderRerankerError,
} from "./reranker.js";
export const RerankerParamsSchema = z.object({ id: z.string().uuid().toLowerCase() }).strict();
export const RerankerQuerySchema = z.object({}).strict();
function fail(reply: FastifyReply, id: string, status: number, detail: string, error?: z.ZodError) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(
      problem({
        status,
        code:
          status === 404
            ? ErrorCode.NOT_FOUND
            : status === 409
              ? ErrorCode.CONFLICT
              : ErrorCode.VALIDATION_FAILED,
        detail,
        requestId: id,
        ...(error ? { errors: zodIssues(error) } : {}),
      }),
    );
}
export function registerProviderRerankerRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  masterKey: Buffer,
) {
  app.register(async (scoped) => {
    scoped.addHook("onRequest", async (_request, reply) => {
      reply.header("cache-control", "no-store");
    });
    const json = async (
      request: { headers: Record<string, string | string[] | undefined>; id: string },
      reply: FastifyReply,
    ) => {
      if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? "")))
        return fail(reply, request.id, 415, "配置修改要求 application/json");
    };
    const handle = async (reply: FastifyReply, id: string, run: () => Promise<unknown>) => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof ProviderRerankerError)
          return fail(
            reply,
            id,
            error.reason === "not_found" ? 404 : error.reason === "endpoint" ? 400 : 409,
            error.reason === "not_found"
              ? "Provider 不存在"
              : error.reason === "endpoint"
                ? "Provider 端点无法组成安全的 Score API 地址"
                : "配置版本冲突或已耗尽，请重新读取",
          );
        if ((error as { code?: string })?.code === "23505")
          return fail(reply, id, 409, "Provider 名称已存在");
        throw error;
      }
    };
    scoped.post("/v1/providers/reranker", { onRequest: json }, async (request, reply) => {
      const q = RerankerQuerySchema.safeParse(request.query),
        body = ProviderRerankerCreateSchema.safeParse(request.body);
      if (!q.success) return fail(reply, request.id, 400, "不接受查询参数", q.error);
      if (!body.success) return fail(reply, request.id, 400, "精排配置参数非法", body.error);
      const result = await handle(reply, request.id, () =>
        createRerankerProvider(db, masterKey, body.data),
      );
      if (reply.sent) return;
      return reply.code(201).send(result);
    });
    scoped.get("/v1/providers/:id/reranker", async (request, reply) => {
      const p = RerankerParamsSchema.safeParse(request.params),
        q = RerankerQuerySchema.safeParse(request.query);
      if (!p.success) return fail(reply, request.id, 400, "Provider ID 非法", p.error);
      if (!q.success) return fail(reply, request.id, 400, "不接受查询参数", q.error);
      return handle(reply, request.id, () => readProviderRerankerConfig(db, p.data.id));
    });
    scoped.put("/v1/providers/:id/reranker", { onRequest: json }, async (request, reply) => {
      const p = RerankerParamsSchema.safeParse(request.params),
        q = RerankerQuerySchema.safeParse(request.query),
        body = ProviderRerankerUpdateSchema.safeParse(request.body);
      if (!p.success) return fail(reply, request.id, 400, "Provider ID 非法", p.error);
      if (!q.success) return fail(reply, request.id, 400, "不接受查询参数", q.error);
      if (!body.success) return fail(reply, request.id, 400, "精排配置参数非法", body.error);
      return handle(reply, request.id, () =>
        updateProviderRerankerConfig(db, p.data.id, body.data),
      );
    });
  });
}
