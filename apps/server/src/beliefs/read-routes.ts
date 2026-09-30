import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { beliefs, beliefVersions, messages, observations } from "../db/schema.js";

/** 记忆中心只读 API + 基础软删除（#8）：列表/详情/版本时间线/删除/恢复。
 *  硬删除与删除传播归 #11；软删除 = status 'deleted'，检索侧已过滤非 active（#6）。 */

const ListQuery = z.object({
  status: z.enum(["active", "deleted", "retracted", "all"]).default("active"),
  profile: z.enum(["true", "false"]).optional(),
  q: z.string().max(200).optional(),
});

function notFound(reply: FastifyReply, requestId: string, id: string) {
  return reply
    .code(404)
    .header("content-type", "application/problem+json")
    .send(
      problem({
        status: 404,
        code: ErrorCode.NOT_FOUND,
        detail: `Belief 不存在：${id}`,
        requestId,
      }),
    );
}

function conflict(reply: FastifyReply, requestId: string, detail: string) {
  return reply
    .code(409)
    .header("content-type", "application/problem+json")
    .send(problem({ status: 409, code: ErrorCode.CONFLICT, detail, requestId }));
}

export function registerBeliefReadRoutes(app: FastifyInstance, db: PostgresJsDatabase): void {
  // ILIKE 通配符转义：用户输入的 % / _ / \ 一律按字面量处理
  const contains = (column: typeof beliefs.subject | typeof beliefs.attribute, q: string) => {
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    return sql`${column} ilike ${`%${escaped}%`} escape '\\'`;
  };

  // 列表：状态/画像过滤 + subject/attribute 搜索；当前值随行列出
  app.get("/projects/:projectId/beliefs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .header("content-type", "application/problem+json")
        .send(
          problem({
            status: 400,
            code: ErrorCode.VALIDATION_FAILED,
            detail: "列表查询参数非法",
            errors: zodIssues(parsed.error),
            requestId: request.id,
          }),
        );
    }
    const { status, profile, q } = parsed.data;
    const conds: SQL[] = [eq(beliefs.projectId, projectId)];
    if (status !== "all") conds.push(eq(beliefs.status, status));
    if (profile) conds.push(eq(beliefs.isProfile, profile === "true"));
    if (q) {
      conds.push(or(contains(beliefs.subject, q), contains(beliefs.attribute, q))!);
    }
    const rows = await db
      .select({
        id: beliefs.id,
        subject: beliefs.subject,
        attribute: beliefs.attribute,
        status: beliefs.status,
        is_profile: beliefs.isProfile,
        confidence: beliefs.confidence,
        salience: beliefs.salience,
        importance: beliefs.importance,
        evidence_count: beliefs.evidenceCount,
        created_at: beliefs.createdAt,
        current_value: beliefVersions.value,
      })
      .from(beliefs)
      .leftJoin(beliefVersions, eq(beliefs.currentVersionId, beliefVersions.id))
      .where(and(...conds))
      .orderBy(asc(beliefs.subject), asc(beliefs.attribute));
    return rows;
  });

  // 详情：当前值 + 完整版本时间线 + 每版来源（observation → 消息 → 会话，供 UI 跳转）。
  // 项目隔离：URL 强制携带 projectId，跨项目一律 404（不泄露存在性，防 ID 枚举）。
  app.get("/projects/:projectId/beliefs/:id", async (request, reply) => {
    const { projectId, id } = request.params as { projectId: string; id: string };
    const [belief] = await db
      .select()
      .from(beliefs)
      .where(and(eq(beliefs.id, id), eq(beliefs.projectId, projectId)))
      .limit(1);
    if (!belief) return notFound(reply, request.id, id);
    const [current] = belief.currentVersionId
      ? await db
          .select({ value: beliefVersions.value })
          .from(beliefVersions)
          .where(eq(beliefVersions.id, belief.currentVersionId))
          .limit(1)
      : [];
    const versions = await db
      .select({
        id: beliefVersions.id,
        value: beliefVersions.value,
        valid_from: beliefVersions.validFrom,
        valid_to: beliefVersions.validTo,
        recorded_from: beliefVersions.recordedFrom,
        recorded_to: beliefVersions.recordedTo,
        supersedes_version_id: beliefVersions.supersedesVersionId,
        confidence: beliefVersions.confidence,
        resolver_version: beliefVersions.resolverVersion,
        observation_id: observations.id,
        message_id: observations.evidenceId,
        conversation_id: messages.conversationId,
      })
      .from(beliefVersions)
      .leftJoin(observations, eq(beliefVersions.sourceObservationId, observations.id))
      .leftJoin(messages, eq(observations.evidenceId, messages.id))
      .where(eq(beliefVersions.beliefId, id))
      .orderBy(asc(beliefVersions.recordedFrom));
    return {
      id: belief.id,
      project_id: belief.projectId,
      subject: belief.subject,
      attribute: belief.attribute,
      status: belief.status,
      is_profile: belief.isProfile,
      confidence: belief.confidence,
      salience: belief.salience,
      importance: belief.importance,
      evidence_count: belief.evidenceCount,
      created_at: belief.createdAt,
      current_value: current?.value ?? null,
      versions: versions.map((v) => ({
        id: v.id,
        value: v.value,
        valid_from: v.valid_from,
        valid_to: v.valid_to,
        recorded_from: v.recorded_from,
        recorded_to: v.recorded_to,
        supersedes_version_id: v.supersedes_version_id,
        confidence: v.confidence,
        resolver_version: v.resolver_version,
        source: v.observation_id
          ? {
              observation_id: v.observation_id,
              message_id: v.message_id,
              conversation_id: v.conversation_id,
            }
          : null,
      })),
    };
  });

  // 基础软删除（#8）：active → deleted；恢复 deleted → active。其余状态迁移拒绝。
  // 与详情同一项目隔离约束。
  app.post("/projects/:projectId/beliefs/:id/delete", async (request, reply) => {
    const { projectId, id } = request.params as { projectId: string; id: string };
    const [belief] = await db
      .select()
      .from(beliefs)
      .where(and(eq(beliefs.id, id), eq(beliefs.projectId, projectId)))
      .limit(1);
    if (!belief) return notFound(reply, request.id, id);
    if (belief.status !== "active") {
      return conflict(reply, request.id, `仅 active 状态可软删除，当前：${belief.status}`);
    }
    await db.update(beliefs).set({ status: "deleted" }).where(eq(beliefs.id, id));
    return { id, status: "deleted" };
  });

  app.post("/projects/:projectId/beliefs/:id/restore", async (request, reply) => {
    const { projectId, id } = request.params as { projectId: string; id: string };
    const [belief] = await db
      .select()
      .from(beliefs)
      .where(and(eq(beliefs.id, id), eq(beliefs.projectId, projectId)))
      .limit(1);
    if (!belief) return notFound(reply, request.id, id);
    if (belief.status !== "deleted") {
      return conflict(reply, request.id, `仅 deleted 状态可恢复，当前：${belief.status}`);
    }
    await db.update(beliefs).set({ status: "active" }).where(eq(beliefs.id, id));
    return { id, status: "active" };
  });
}
