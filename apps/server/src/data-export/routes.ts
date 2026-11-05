import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { MemoryExportRequestSchema, MemoryExportQuerySchema } from "../contracts/data-export.js";
import { prepareMemoryExport } from "./repository.js";
import { MemoryExportError } from "./codec.js";

export function registerMemoryExportRoutes(app: FastifyInstance, db: PostgresJsDatabase) {
  app.post(
    "/v1/exports/memory",
    {
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? ""))
          return reply
            .code(415)
            .type("application/problem+json")
            .send(
              problem({
                status: 415,
                code: ErrorCode.VALIDATION_FAILED,
                requestId: request.id,
                detail: "记忆导出需要 application/json",
              }),
            );
      },
    },
    async (request, reply) => {
      const body = MemoryExportRequestSchema.safeParse(request.body),
        query = MemoryExportQuerySchema.safeParse(request.query);
      const error = !body.success ? body.error : !query.success ? query.error : undefined;
      if (error)
        return reply
          .code(400)
          .type("application/problem+json")
          .send(
            problem({
              status: 400,
              code: ErrorCode.VALIDATION_FAILED,
              requestId: request.id,
              detail: "必须显式指定实例范围，且不接受查询参数",
              errors: zodIssues(error),
            }),
          );
      try {
        const { payload, export_id } = await prepareMemoryExport(db);
        // This executes only after the transaction and prepared audit COMMIT succeed.
        return reply
          .type("application/x-ndjson")
          .header("content-disposition", `attachment; filename="mnemic-memory-${export_id}.jsonl"`)
          .header("x-content-type-options", "nosniff")
          .send(payload);
      } catch (error) {
        if (error instanceof MemoryExportError && error.code === "EXPORT_LIMIT_EXCEEDED")
          return reply
            .code(413)
            .type("application/problem+json")
            .send(
              problem({
                status: 413,
                code: ErrorCode.VALIDATION_FAILED,
                requestId: request.id,
                detail: "归档超出固定导出上限；未生成部分文件",
              }),
            );
        throw error;
      }
    },
  );
}
