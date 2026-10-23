import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { conversations } from "../db/schema.js";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import type { ProviderFactory } from "../providers/factory.js";
import type { retrieve } from "../retrieval/search.js";
import { trackJob } from "./jobs.js";
import { CORRECTIONS_CONVERSATION_TITLE } from "./conversation-titles.js";
import { respondToMessage } from "./respond.js";
import { commitConversation, createConversation } from "./service.js";
import { resumeConversation } from "./resume.js";
import { ConversationContextError } from "./context.js";
import { ChatGenerations } from "./generations.js";
import { registerChatStreamRoutes } from "./stream-routes.js";

/** 对话闭环 API（#7）：会话创建/提交/消息应答 */

export interface ChatRouteDeps {
  /** 测试注入 Fake 工厂；生产缺省真实双协议工厂 */
  factory?: ProviderFactory;
  /** 测试注入检索替身（阈值放宽/故障注入） */
  retrieveFn?: typeof retrieve;
  /** Total generation deadline; production default 300s. Shorter only for isolated tests. */
  streamTimeoutMs?: number;
}

const CreateConversation = z.object({
  project_id: z.string().uuid(),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((title) => title !== CORRECTIONS_CONVERSATION_TITLE, "该标题为专用修正会话保留")
    .optional(),
});

const PostMessage = z.object({
  text: z.string().min(1).max(8000),
});

export function registerChatRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  masterKey: Buffer,
  deps: ChatRouteDeps = {},
): void {
  const modelOpts = deps.factory ? { factory: deps.factory } : {};
  const generations = new ChatGenerations();
  registerChatStreamRoutes(
    app,
    db,
    masterKey,
    generations,
    {
      ...modelOpts,
      ...(deps.retrieveFn ? { retrieveFn: deps.retrieveFn } : {}),
      onJob: (job) => trackJob(job, () => app.log.warn("stream writeback failed")),
      logger: { warn: (_obj, msg) => app.log.warn(msg) },
    },
    deps.streamTimeoutMs,
  );

  app.post("/projects/:projectId/conversations/:id/resume", async (request, reply) => {
    const params = z
      .object({ projectId: z.string().uuid(), id: z.string().uuid() })
      .safeParse(request.params);
    const body = z
      .object({ current_conversation_id: z.string().uuid().optional() })
      .strict()
      .safeParse(request.body);
    const invalid = (error: z.ZodError) =>
      reply
        .code(400)
        .type("application/problem+json")
        .send(
          problem({
            status: 400,
            code: ErrorCode.VALIDATION_FAILED,
            detail: "恢复参数非法",
            requestId: request.id,
            errors: zodIssues(error),
          }),
        );
    if (!params.success) return invalid(params.error);
    if (!body.success) return invalid(body.error);
    // Scope BOTH source and current IDs before revealing an in-process busy state.
    const ids = [
      ...new Set(
        [
          params.data.id,
          ...(body.data.current_conversation_id ? [body.data.current_conversation_id] : []),
        ].map((id) => id.toLowerCase()),
      ),
    ];
    const scoped = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.projectId, params.data.projectId), inArray(conversations.id, ids)),
      );
    if (scoped.length !== ids.length)
      return reply
        .code(404)
        .type("application/problem+json")
        .send(
          problem({
            status: 404,
            code: ErrorCode.NOT_FOUND,
            detail: "会话不存在",
            requestId: request.id,
          }),
        );
    return generations.guard(async () => {
      try {
        const result = await resumeConversation(
          db,
          masterKey,
          params.data.projectId,
          params.data.id,
          body.data.current_conversation_id,
          {
            ...modelOpts,
            onJob: (job) =>
              trackJob(job, (err) => request.log.error({ err }, "resume writeback failed")),
            logger: { error: (obj, msg) => request.log.error(obj, msg) },
          },
        );
        if (result.kind === "resumed") return reply.code(201).send(result.conversation);
        const status = result.kind === "not_found" ? 404 : 409;
        return reply
          .code(status)
          .type("application/problem+json")
          .send(
            problem({
              status,
              code: status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT,
              detail: status === 404 ? "会话不存在" : "专用修正会话不能恢复",
              requestId: request.id,
            }),
          );
      } catch (error) {
        if (!(error instanceof ConversationContextError)) throw error;
        return reply
          .code(409)
          .type("application/problem+json")
          .send(
            problem({
              status: 409,
              code: ErrorCode.CONFLICT,
              detail: "会话历史引用不可用",
              requestId: request.id,
            }),
          );
      }
    })(request, reply);
  });

  app.post("/v1/conversations", async (request, reply) => {
    const parsed = CreateConversation.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .header("content-type", "application/problem+json")
        .send(
          problem({
            status: 400,
            code: ErrorCode.VALIDATION_FAILED,
            detail: "会话创建参数非法",
            errors: zodIssues(parsed.error),
            requestId: request.id,
          }),
        );
    }
    const conversation = await createConversation(db, {
      projectId: parsed.data.project_id,
      title: parsed.data.title,
    });
    if (!conversation) {
      return reply
        .code(404)
        .header("content-type", "application/problem+json")
        .send(
          problem({
            status: 404,
            code: ErrorCode.NOT_FOUND,
            detail: `项目不存在：${parsed.data.project_id}`,
            requestId: request.id,
          }),
        );
    }
    return conversation;
  });

  app.post(
    "/v1/conversations/:id/commit",
    generations.guard(async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await commitConversation(db, masterKey, id, {
        ...modelOpts,
        onJob: (job) =>
          trackJob(job, (err) =>
            request.log.error({ err, conversationId: id }, "commit writeback failed"),
          ),
        logger: { error: (obj, msg) => request.log.error(obj, msg) },
      });
      if (result.kind === "not_found") {
        return reply
          .code(404)
          .header("content-type", "application/problem+json")
          .send(
            problem({
              status: 404,
              code: ErrorCode.NOT_FOUND,
              detail: `会话不存在：${id}`,
              requestId: request.id,
            }),
          );
      }
      if (result.kind === "already_ended") {
        return reply
          .code(409)
          .header("content-type", "application/problem+json")
          .send(
            problem({
              status: 409,
              code: ErrorCode.CONFLICT,
              detail: `会话已提交：${id}`,
              requestId: request.id,
            }),
          );
      }
      return {
        ...result.conversation,
        extraction_triggered: result.extractionTriggered,
      };
    }),
  );

  app.post(
    "/v1/conversations/:id/messages",
    generations.guard(async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = PostMessage.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .header("content-type", "application/problem+json")
          .send(
            problem({
              status: 400,
              code: ErrorCode.VALIDATION_FAILED,
              detail: "消息参数非法",
              errors: zodIssues(parsed.error),
              requestId: request.id,
            }),
          );
      }
      const result = await respondToMessage(db, masterKey, id, parsed.data.text, {
        ...modelOpts,
        ...(deps.retrieveFn ? { retrieveFn: deps.retrieveFn } : {}),
        onJob: (job) =>
          trackJob(job, (err) =>
            request.log.error({ err, conversationId: id }, "message writeback failed"),
          ),
        logger: { warn: (obj, msg) => request.log.warn(obj, msg) },
      });
      if (result.kind === "not_found") {
        return reply
          .code(404)
          .header("content-type", "application/problem+json")
          .send(
            problem({
              status: 404,
              code: ErrorCode.NOT_FOUND,
              detail: `会话不存在：${id}`,
              requestId: request.id,
            }),
          );
      }
      if (result.kind === "ended" || result.kind === "context_invalid") {
        return reply
          .code(409)
          .header("content-type", "application/problem+json")
          .send(
            problem({
              status: 409,
              code: ErrorCode.CONFLICT,
              detail:
                result.kind === "context_invalid"
                  ? "会话历史引用不可用"
                  : `会话已提交，不能再发消息：${id}`,
              requestId: request.id,
            }),
          );
      }
      return {
        message_id: result.messageId,
        answer: result.answer,
        memories: result.memories,
        abstained: result.abstained,
        history_included: result.historyIncluded,
      };
    }),
  );
}
