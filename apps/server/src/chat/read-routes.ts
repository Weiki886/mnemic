import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { conversations, messages } from "../db/schema.js";
import {
  ConversationContextError,
  inheritedMessageIds,
  loadConversationMessages,
  messageViews,
} from "./context.js";

/** 对话只读视图 API（#8）：交互式对话不做，仅会话列表 + 消息时间线 + 引用记忆现查解析。
 *  messages.memories 只存 belief_version_id（决策 8），读出时 join 现查内容。 */

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const ProjectParams = z.object({ projectId: z.string().uuid() });
const ConvParams = ProjectParams.extend({ id: z.string().uuid() });

function unavailable(reply: FastifyReply, requestId: string) {
  return reply
    .code(409)
    .type("application/problem+json")
    .send(
      problem({ status: 409, code: ErrorCode.CONFLICT, detail: "会话历史引用不可用", requestId }),
    );
}

function badRequest(reply: FastifyReply, requestId: string, detail: string, error: z.ZodError) {
  return reply
    .code(400)
    .header("content-type", "application/problem+json")
    .send(
      problem({
        status: 400,
        code: ErrorCode.VALIDATION_FAILED,
        detail,
        errors: zodIssues(error),
        requestId,
      }),
    );
}

export function registerConversationReadRoutes(app: FastifyInstance, db: PostgresJsDatabase): void {
  // 会话列表（按项目），带消息数
  app.get("/projects/:projectId/conversations", async (request, reply: FastifyReply) => {
    const params = ProjectParams.safeParse(request.params);
    if (!params.success) {
      return badRequest(reply, request.id, "路径参数非法：projectId 必须为 UUID", params.error);
    }
    const query = ListQuery.safeParse(request.query);
    if (!query.success) {
      return badRequest(reply, request.id, "列表查询参数非法", query.error);
    }
    const { projectId } = params.data;
    const { limit, offset } = query.data;
    const convs = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        started_at: conversations.startedAt,
        ended_at: conversations.endedAt,
        meta: conversations.meta,
      })
      .from(conversations)
      .where(eq(conversations.projectId, projectId))
      .orderBy(asc(conversations.startedAt), asc(conversations.id))
      .limit(limit)
      .offset(offset);
    if (convs.length === 0) return [];
    const refsBy = new Map<string, string[]>();
    try {
      for (const c of convs) refsBy.set(c.id, inheritedMessageIds(c.meta));
    } catch (error) {
      if (!(error instanceof ConversationContextError)) throw error;
      return unavailable(reply, request.id);
    }
    const referenceIds = [...new Set([...refsBy.values()].flat())];
    const counts = await db
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.projectId, projectId),
          or(
            inArray(
              messages.conversationId,
              convs.map((c) => c.id),
            ),
            referenceIds.length ? inArray(messages.id, referenceIds) : undefined,
          ),
        ),
      );
    const found = new Set(counts.map((m) => m.id));
    if (referenceIds.some((id) => !found.has(id))) return unavailable(reply, request.id);
    return convs.map(({ meta: _meta, ...c }) => {
      const refs = new Set(refsBy.get(c.id));
      return {
        ...c,
        message_count: counts.filter((m) => m.conversationId === c.id || refs.has(m.id)).length,
      };
    });
  });

  // 会话详情：消息时间线 + 引用记忆（版本 ID → 现查 subject/attribute/value）。
  // 项目隔离：URL 强制携带 projectId，跨项目一律 404（不泄露存在性）。
  app.get("/projects/:projectId/conversations/:id", async (request, reply: FastifyReply) => {
    const params = ConvParams.safeParse(request.params);
    if (!params.success) {
      return badRequest(reply, request.id, "路径参数非法：必须为 UUID", params.error);
    }
    const { projectId, id } = params.data;
    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.projectId, projectId)))
      .limit(1);
    if (!conv) {
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
    let views;
    try {
      views = await messageViews(db, projectId, await loadConversationMessages(db, conv));
    } catch (error) {
      if (!(error instanceof ConversationContextError)) throw error;
      return unavailable(reply, request.id);
    }
    return {
      id: conv.id,
      project_id: conv.projectId,
      title: conv.title,
      started_at: conv.startedAt,
      ended_at: conv.endedAt,
      messages: views,
    };
  });
}
