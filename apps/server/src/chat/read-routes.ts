import { and, asc, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { beliefVersions, beliefs, conversations, messages } from "../db/schema.js";

/** 对话只读视图 API（#8）：交互式对话不做，仅会话列表 + 消息时间线 + 引用记忆现查解析。
 *  messages.memories 只存 belief_version_id（决策 8），读出时 join 现查内容。 */

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const ProjectParams = z.object({ projectId: z.string().uuid() });
const ConvParams = ProjectParams.extend({ id: z.string().uuid() });

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
      })
      .from(conversations)
      .where(eq(conversations.projectId, projectId))
      .orderBy(asc(conversations.startedAt))
      .limit(limit)
      .offset(offset);
    if (convs.length === 0) return [];
    const counts = await db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(
        inArray(
          messages.conversationId,
          convs.map((c) => c.id),
        ),
      );
    const countBy = new Map<string, number>();
    for (const row of counts) {
      countBy.set(row.conversationId, (countBy.get(row.conversationId) ?? 0) + 1);
    }
    return convs.map((c) => ({ ...c, message_count: countBy.get(c.id) ?? 0 }));
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
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.msgTime));
    // 汇总全部引用版本 ID，一次 join 现查
    const versionIds = [
      ...new Set(msgs.flatMap((m) => (Array.isArray(m.memories) ? (m.memories as string[]) : []))),
    ];
    const cited =
      versionIds.length > 0
        ? await db
            .select({
              versionId: beliefVersions.id,
              beliefId: beliefs.id,
              subject: beliefs.subject,
              attribute: beliefs.attribute,
              value: beliefVersions.value,
            })
            .from(beliefVersions)
            .innerJoin(beliefs, eq(beliefVersions.beliefId, beliefs.id))
            // 不信任 jsonb 内容：join 时重新断言项目边界，跨项目引用静默过滤
            .where(
              and(inArray(beliefVersions.id, versionIds), eq(beliefs.projectId, conv.projectId)),
            )
        : [];
    const citedBy = new Map(cited.map((c) => [c.versionId, c]));
    return {
      id: conv.id,
      project_id: conv.projectId,
      title: conv.title,
      started_at: conv.startedAt,
      ended_at: conv.endedAt,
      messages: msgs.map((m) => ({
        id: m.id,
        speaker: m.speaker,
        raw_text: m.rawText,
        msg_time: m.msgTime,
        memories: Array.isArray(m.memories)
          ? (m.memories as string[]).flatMap((vid) => {
              const c = citedBy.get(vid);
              return c
                ? [
                    {
                      belief_version_id: c.versionId,
                      belief_id: c.beliefId,
                      subject: c.subject,
                      attribute: c.attribute,
                      value: c.value,
                    },
                  ]
                : [];
            })
          : null,
      })),
    };
  });
}
