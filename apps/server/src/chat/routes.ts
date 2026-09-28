import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import type { ProviderFactory } from "../providers/factory.js";
import type { retrieve } from "../retrieval/search.js";
import { trackJob } from "./jobs.js";
import { respondToMessage } from "./respond.js";
import { commitConversation, createConversation } from "./service.js";

/** 对话闭环 API（#7）：会话创建/提交/消息应答 */

export interface ChatRouteDeps {
  /** 测试注入 Fake 工厂；生产缺省真实双协议工厂 */
  factory?: ProviderFactory;
  /** 测试注入检索替身（阈值放宽/故障注入） */
  retrieveFn?: typeof retrieve;
}

const CreateConversation = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
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

  app.post("/v1/conversations", async (request, reply) => {
    const parsed = CreateConversation.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).header("content-type", "application/problem+json").send(
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
      return reply.code(404).header("content-type", "application/problem+json").send(
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

  app.post("/v1/conversations/:id/commit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await commitConversation(db, masterKey, id, {
      ...modelOpts,
      onJob: (job) =>
        trackJob(job, (err) => request.log.error({ err, conversationId: id }, "commit writeback failed")),
    });
    if (result.kind === "not_found") {
      return reply.code(404).header("content-type", "application/problem+json").send(
        problem({
          status: 404,
          code: ErrorCode.NOT_FOUND,
          detail: `会话不存在：${id}`,
          requestId: request.id,
        }),
      );
    }
    if (result.kind === "already_ended") {
      return reply.code(409).header("content-type", "application/problem+json").send(
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
  });

  app.post("/v1/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = PostMessage.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).header("content-type", "application/problem+json").send(
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
        trackJob(job, (err) => request.log.error({ err, conversationId: id }, "message writeback failed")),
      logger: { warn: (obj, msg) => request.log.warn(obj, msg) },
    });
    if (result.kind === "not_found") {
      return reply.code(404).header("content-type", "application/problem+json").send(
        problem({
          status: 404,
          code: ErrorCode.NOT_FOUND,
          detail: `会话不存在：${id}`,
          requestId: request.id,
        }),
      );
    }
    if (result.kind === "ended") {
      return reply.code(409).header("content-type", "application/problem+json").send(
        problem({
          status: 409,
          code: ErrorCode.CONFLICT,
          detail: `会话已提交，不能再发消息：${id}`,
          requestId: request.id,
        }),
      );
    }
    return {
      message_id: result.messageId,
      answer: result.answer,
      memories: result.memories,
      abstained: result.abstained,
    };
  });
}
