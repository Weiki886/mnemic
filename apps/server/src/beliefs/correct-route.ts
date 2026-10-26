import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { beliefs, conversations, messages, resolutionTraces } from "../db/schema.js";
import { AUTHORITY_TABLE } from "../extraction/authority.js";
import { ingestCandidate } from "../ingest/ingest.js";
import { CORRECTIONS_CONVERSATION_TITLE } from "../chat/conversation-titles.js";
import { badRequest, notFound, conflict } from "./problem-responses.js";
import { emitDebugTrace, type DebugTrace } from "../debug/trace.js";
import { toApiNumber } from "./serialization.js";

/** 人工修正入口（#17）：产生 USER_CORRECTION(70) 权威版本，provenance 锚到项目专用修正会话 */

const CorrectBody = z.object({ value: z.string().min(1) });
const BeliefParams = z.object({ projectId: z.string().uuid(), id: z.string().uuid() });

export function registerBeliefRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  debugTrace?: DebugTrace,
): void {
  // 消解历史查询（#18）：UI 版本时间线与实验分析消费
  app.get("/projects/:projectId/beliefs/:id/resolutions", async (request, reply) => {
    const params = BeliefParams.safeParse(request.params);
    if (!params.success) {
      return badRequest(
        reply,
        request.id,
        "路径参数非法：projectId 和 id 必须为 UUID",
        params.error,
      );
    }
    const { projectId, id } = params.data;
    const [belief] = await db
      .select({ id: beliefs.id })
      .from(beliefs)
      .where(and(eq(beliefs.id, id), eq(beliefs.projectId, projectId)))
      .limit(1);
    if (!belief) return notFound(reply, request.id, id);
    const rows = await db
      .select()
      .from(resolutionTraces)
      .where(and(eq(resolutionTraces.beliefId, id), eq(resolutionTraces.projectId, projectId)))
      .orderBy(asc(resolutionTraces.createdAt));
    return rows.map((row) => ({
      ...row,
      confidenceBefore: toApiNumber(row.confidenceBefore),
      confidenceAfter: toApiNumber(row.confidenceAfter),
    }));
  });

  app.post("/projects/:projectId/beliefs/:id/correct", async (request, reply) => {
    const params = BeliefParams.safeParse(request.params);
    if (!params.success) {
      return badRequest(
        reply,
        request.id,
        "路径参数非法：projectId 和 id 必须为 UUID",
        params.error,
      );
    }
    const { projectId, id } = params.data;
    const parsed = CorrectBody.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, request.id, "value（非空字符串）为必填字段", parsed.error);
    }
    // 与 delete/restore 的条件 UPDATE 串行：状态检查、provenance、标准写入链共享同一事务。
    // Resolver 的嵌套事务是同一连接的 savepoint；提交前不会释放该信念的行锁。
    const outcome = await db.transaction(async (tx) => {
      const [belief] = await tx
        .select()
        .from(beliefs)
        .where(and(eq(beliefs.id, id), eq(beliefs.projectId, projectId)))
        .limit(1)
        .for("update");
      if (!belief) return { kind: "missing" as const };
      if (belief.status === "deleted") return { kind: "deleted" as const };

      // #70：先尝试创建，唯一冲突后另发 SELECT（READ COMMITTED 下能看到对方已提交的行）。
      const [created] = await tx
        .insert(conversations)
        .values({
          id: uuidv7(),
          projectId,
          title: CORRECTIONS_CONVERSATION_TITLE,
        })
        .onConflictDoNothing({
          target: conversations.projectId,
          // 固定字面量与部分唯一索引匹配，不能用参数化谓词依赖执行计划推断。
          where: sql`${conversations.title} = 'manual-corrections'`,
        })
        .returning({ id: conversations.id });
      const [conversation] = created
        ? [created]
        : await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.projectId, projectId),
                eq(conversations.title, CORRECTIONS_CONVERSATION_TITLE),
              ),
            )
            .limit(1);
      if (!conversation) throw new Error("专用修正会话不可用");
      const conversationId = conversation.id;
      const messageId = uuidv7();
      await tx.insert(messages).values({
        id: messageId,
        conversationId,
        speaker: "user",
        rawText: `人工修正：${belief.subject} / ${belief.attribute} → ${parsed.data.value}`,
        msgTime: new Date(),
      });

      // 走标准写入链（#16 去重分流 → #5 Resolver，意图 CORRECT + 权威 USER_CORRECTION）
      const result = await ingestCandidate(
        tx,
        projectId,
        {
          type: "fact",
          subject: belief.subject,
          attribute: belief.attribute,
          value: parsed.data.value,
          valid_time: new Date().toISOString(),
          time_precision: "DAY",
          time_confidence: 1,
          assertion_intent: "CORRECT",
          source_type: "USER_CORRECTION",
          importance: Number(belief.importance ?? 0.8),
          confidence: 1,
          entities: [],
          is_profile: belief.isProfile,
          authority: AUTHORITY_TABLE.USER_CORRECTION.authority,
          reliability: AUTHORITY_TABLE.USER_CORRECTION.reliability,
        },
        messageId,
      );
      return { kind: "corrected" as const, result, conversationId };
    });
    if (outcome.kind === "missing") {
      return notFound(reply, request.id, id);
    }

    if (outcome.kind === "deleted") {
      return conflict(reply, request.id, "已删除的记忆必须先恢复，再进行修正");
    }
    const { result } = outcome;
    emitDebugTrace(debugTrace, {
      event: "memory.belief.corrected",
      target_id: id,
      detail: {
        project_id: projectId,
        conversation_id: outcome.conversationId,
        observation_id: result.observationId,
        route: result.route,
        relation: result.relation,
      },
    });
    return { beliefId: result.beliefId, route: result.route, relation: result.relation };
  });
}
