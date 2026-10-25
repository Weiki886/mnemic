import type { FastifyInstance, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { UsageQuerySchema, UsageExportQuerySchema } from "@mnemic/shared/usage";
import { assertUsageScope, readUsageReport, readUsageExport, UsageScopeError } from "./read.js";
import { usageCsv } from "./csv.js";
import { usageWindow, type UsagePricing } from "./pricing.js";
const Params = z.object({ projectId: z.string().uuid().toLowerCase() }).strict();
function fail(reply: FastifyReply, requestId: string, status: 400 | 404, error?: z.ZodError) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(
      problem({
        status,
        requestId,
        code: status === 400 ? ErrorCode.VALIDATION_FAILED : ErrorCode.NOT_FOUND,
        detail:
          status === 400
            ? "用量查询参数非法；时间范围须大于0且不超过366天"
            : "项目范围内未找到记录",
        ...(error ? { errors: zodIssues(error) } : {}),
      }),
    );
}
export function registerUsageRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  pricing?: UsagePricing,
) {
  for (const exporting of [false, true])
    app.get(`/projects/:projectId/usage${exporting ? "/export" : ""}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("access-control-expose-headers", "X-Next-After, X-Usage-From, X-Usage-To");
      const params = Params.safeParse(request.params);
      if (!params.success) return fail(reply, request.id, 400, params.error);
      const parsed = (exporting ? UsageExportQuerySchema : UsageQuerySchema).safeParse(
        request.query,
      );
      if (!parsed.success) return fail(reply, request.id, 400, parsed.error);
      try {
        usageWindow(parsed.data);
      } catch {
        return fail(
          reply,
          request.id,
          400,
          new z.ZodError([
            { code: "custom", path: ["from"], message: "时间范围须大于0且不超过366天" },
          ]),
        );
      }
      try {
        await assertUsageScope(db, params.data.projectId, parsed.data.conversation_id);
        if (!exporting)
          return await readUsageReport(
            db,
            params.data.projectId,
            UsageQuerySchema.parse(parsed.data),
            pricing,
          );
        const page = await readUsageExport(
          db,
          params.data.projectId,
          UsageExportQuerySchema.parse(parsed.data),
          pricing,
        );
        if (page.next_after) reply.header("x-next-after", page.next_after);
        reply.header("x-usage-from", page.from).header("x-usage-to", page.to);
        if ("format" in parsed.data && parsed.data.format === "csv")
          return reply
            .type("text/csv; charset=utf-8")
            .header("content-disposition", 'attachment; filename="usage.csv"')
            .send(usageCsv(page));
        return page;
      } catch (error) {
        if (error instanceof UsageScopeError) return fail(reply, request.id, 404);
        throw error;
      }
    });
}
