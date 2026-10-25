import type { FastifyInstance, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { RecallRequestSchema, RecallResultSchema } from "@mnemic/shared/memory";
import { projects, retrievalTraces } from "../db/schema.js";
import type { ProviderFactory } from "../providers/factory.js";
import { retrieve } from "./search.js";

const Params = z.object({ projectId: z.string().uuid() });
function fail(
  reply: FastifyReply,
  requestId: string,
  status: number,
  code: ErrorCode,
  detail: string,
  errors?: ReturnType<typeof zodIssues>,
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(problem({ status, code, detail, requestId, ...(errors ? { errors } : {}) }));
}

/** 显式 CLI 操作：POST 可计费，不提供 GET，不接受浏览器 Origin。 */
export function registerRecallRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  masterKey: Buffer,
  factory?: ProviderFactory,
): void {
  app.post(
    "/projects/:projectId/recall",
    {
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (request.headers.origin !== undefined)
          return fail(
            reply,
            request.id,
            403,
            ErrorCode.FORBIDDEN,
            "手动召回仅支持 CLI，不接受浏览器 Origin 请求",
          );
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
          return fail(
            reply,
            request.id,
            415,
            ErrorCode.VALIDATION_FAILED,
            "手动召回要求 Content-Type: application/json",
          );
      },
    },
    async (request, reply) => {
      const params = Params.safeParse(request.params);
      if (!params.success)
        return fail(
          reply,
          request.id,
          400,
          ErrorCode.VALIDATION_FAILED,
          "项目 ID 无效",
          zodIssues(params.error),
        );
      const body = RecallRequestSchema.safeParse(request.body);
      if (!body.success)
        return fail(
          reply,
          request.id,
          400,
          ErrorCode.VALIDATION_FAILED,
          "查询须为 1–1000 字符，不接受其他参数",
          zodIssues(body.error),
        );
      const { projectId } = params.data;
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project) return fail(reply, request.id, 404, ErrorCode.NOT_FOUND, "项目不存在");
      try {
        const result = await retrieve(db, masterKey, projectId, body.data.query, {
          usageLogger: app.log,
          ...(factory ? { factory } : {}),
          topK: 5,
          reinforce: false,
          signal: AbortSignal.timeout(30_000),
        });
        const [trace] = await db
          .select()
          .from(retrievalTraces)
          .where(
            and(eq(retrievalTraces.id, result.traceId), eq(retrievalTraces.projectId, projectId)),
          )
          .limit(1);
        if (!trace || !Array.isArray(trace.candidates)) throw new Error("missing trace");
        return RecallResultSchema.parse({
          project_id: projectId,
          query: body.data.query,
          abstained: result.abstained,
          candidates: result.candidates,
          trace: {
            id: trace.id,
            reinforce_enabled: false,
            candidate_count: trace.candidates.length,
            truncated: trace.candidates.length > 200,
            candidates: trace.candidates.slice(0, 200),
          },
        });
      } catch {
        // 不记录 SDK/SQL 原始异常，避免上游凭据/查询正文进入日志。
        return fail(
          reply,
          request.id,
          500,
          ErrorCode.INTERNAL_ERROR,
          "手动召回失败；未自动重试，检索轨迹可能已写入",
        );
      }
    },
  );
}
