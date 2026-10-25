import type { FastifyInstance, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { conversations, messages } from "../db/schema.js";
import { enterMessage, type RespondOptions } from "./respond.js";
import { ChatGenerations, generationConflict } from "./generations.js";
import { createChatStream } from "./streaming.js";
import { ChatMessageInputSchema } from "@mnemic/shared/file-context";

const UUID = z.string().uuid().toLowerCase();
const Params = z.object({ projectId: UUID, id: UUID });
const CancelParams = Params.extend({ generationId: UUID });
const Body = ChatMessageInputSchema;
function bad(reply: FastifyReply, requestId: string, error: z.ZodError) {
  return reply
    .code(400)
    .type("application/problem+json")
    .send(
      problem({
        status: 400,
        code: ErrorCode.VALIDATION_FAILED,
        detail: "流式对话参数非法",
        errors: zodIssues(error),
        requestId,
      }),
    );
}
function missing(reply: FastifyReply, requestId: string) {
  return reply
    .code(404)
    .type("application/problem+json")
    .send(
      problem({ status: 404, code: ErrorCode.NOT_FOUND, detail: "会话或生成不存在", requestId }),
    );
}
export function registerChatStreamRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  masterKey: Buffer,
  generations: ChatGenerations,
  options: RespondOptions,
  timeoutMs?: number,
) {
  // preClose runs before Fastify waits for active streaming connections (onClose would be too late).
  app.addHook("preClose", async () => generations.shutdown());
  app.post("/projects/:projectId/conversations/:id/messages/stream", async (request, reply) => {
    const params = Params.safeParse(request.params),
      body = Body.safeParse(request.body);
    if (!params.success) return bad(reply, request.id, params.error);
    if (!body.success) return bad(reply, request.id, body.error);
    const { projectId, id } = params.data;
    // Check scope before consulting the process registry: a foreign project must not learn busy/existence state.
    const [scoped] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.projectId, projectId)))
      .limit(1);
    if (!scoped) return missing(reply, request.id);
    const generation = generations.start(projectId, id);
    if (!generation)
      return generationConflict(reply, request.id, generations.atCapacity ? "capacity" : undefined);
    const closed = () => generation.controller.abort();
    reply.raw.once("close", closed);
    if (reply.raw.destroyed) closed();
    let admitted = false;
    try {
      const entered = await enterMessage(db, id, body.data.text, projectId, body.data.attachments);
      if (entered.kind === "not_found") return missing(reply, request.id);
      if (entered.kind !== "ok")
        return reply
          .code(409)
          .type("application/problem+json")
          .send(
            problem({
              status: 409,
              code: ErrorCode.CONFLICT,
              detail: entered.kind === "context_invalid" ? "会话历史引用不可用" : "会话已提交",
              requestId: request.id,
            }),
          );
      const stream = createChatStream(
        db,
        masterKey,
        entered,
        body.data.text,
        generation,
        options,
        timeoutMs,
      );
      if (reply.raw.destroyed) stream.destroy();
      // Stream close handles interruption only until the saved terminal decision.
      reply.raw.removeListener("close", closed);
      reply.raw.once("close", () => stream.destroy());
      admitted = true;
      return reply
        .type("text/event-stream; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-accel-buffering", "no")
        .send(stream);
    } finally {
      reply.raw.removeListener("close", closed);
      if (!admitted) generation.finish();
    }
  });
  app.post(
    "/projects/:projectId/conversations/:id/generations/:generationId/cancel",
    async (request, reply) => {
      const params = CancelParams.safeParse(request.params),
        body = z
          .object({})
          .strict()
          .safeParse(request.body ?? {});
      if (!params.success) return bad(reply, request.id, params.error);
      if (!body.success) return bad(reply, request.id, body.error);
      const { projectId, id, generationId } = params.data;
      const active = generations.find(projectId, id, generationId);
      if (active) {
        active.controller.abort();
        await active.done;
      }
      const [row] = await db
        .select({ id: messages.id, status: messages.generationStatus })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.projectId, projectId),
            eq(conversations.id, id),
            eq(messages.id, generationId),
            eq(messages.speaker, "assistant"),
          ),
        )
        .limit(1);
      if (!row?.status) {
        if (active)
          return reply
            .code(500)
            .type("application/problem+json")
            .send(
              problem({
                status: 500,
                code: ErrorCode.INTERNAL_ERROR,
                detail: "生成结果未能保存，不能确认取消完成",
                requestId: request.id,
              }),
            );
        return missing(reply, request.id);
      }
      return { generation_id: generationId, message_id: row.id, status: row.status };
    },
  );
}
