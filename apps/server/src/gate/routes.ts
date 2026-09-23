import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { ErrorCode, problem } from "@mnemic/shared";
import { listPending, updatePendingStatus } from "./pending-repository.js";

/** 待确认列表 API（#15）：PENDING 候选的人工确认/拒绝入口（记忆中心消费） */

const ListQuery = z.object({
  project_id: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "expired", "rejected", "promoted"]).optional(),
});

export function registerGateRoutes(app: FastifyInstance, db: PostgresJsDatabase): void {
  app.get("/pending", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).header("content-type", "application/problem+json").send(
        problem({
          status: 400,
          code: ErrorCode.VALIDATION_FAILED,
          detail: "project_id（uuid）为必填查询参数",
          requestId: request.id,
        }),
      );
    }
    return listPending(db, parsed.data.project_id, parsed.data.status ?? "pending");
  });

  for (const [action, status] of [
    ["confirm", "confirmed"],
    ["reject", "rejected"],
  ] as const) {
    app.post(`/pending/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await updatePendingStatus(db, id, status);
      } catch {
        return reply.code(404).header("content-type", "application/problem+json").send(
          problem({
            status: 404,
            code: ErrorCode.NOT_FOUND,
            detail: `PENDING 候选不存在：${id}`,
            requestId: request.id,
          }),
        );
      }
    });
  }
}
