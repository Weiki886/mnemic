import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { beliefs, conversations, messages, resolutionTraces } from "../db/schema.js";
import { AUTHORITY_TABLE } from "../extraction/authority.js";
import { ingestCandidate } from "../ingest/ingest.js";

/** 人工修正入口（#17）：产生 USER_CORRECTION(70) 权威版本，provenance 锚到项目专用修正会话 */

const CorrectBody = z.object({ value: z.string().min(1) });
const CORRECTIONS_CONVERSATION_TITLE = "manual-corrections";

export function registerBeliefRoutes(app: FastifyInstance, db: PostgresJsDatabase): void {
  // 消解历史查询（#18）：UI 版本时间线与实验分析消费
  app.get("/beliefs/:id/resolutions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [belief] = await db.select({ id: beliefs.id }).from(beliefs).where(eq(beliefs.id, id)).limit(1);
    if (!belief) {
      return reply.code(404).header("content-type", "application/problem+json").send(
        problem({
          status: 404,
          code: ErrorCode.NOT_FOUND,
          detail: `Belief 不存在：${id}`,
          requestId: request.id,
        }),
      );
    }
    return db
      .select()
      .from(resolutionTraces)
      .where(eq(resolutionTraces.beliefId, id))
      .orderBy(asc(resolutionTraces.createdAt));
  });

  app.post("/beliefs/:id/correct", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = CorrectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).header("content-type", "application/problem+json").send(
        problem({
          status: 400,
          code: ErrorCode.VALIDATION_FAILED,
          detail: "value（非空字符串）为必填字段",
          errors: zodIssues(parsed.error),
          requestId: request.id,
        }),
      );
    }
    const [belief] = await db.select().from(beliefs).where(eq(beliefs.id, id)).limit(1);
    if (!belief) {
      return reply.code(404).header("content-type", "application/problem+json").send(
        problem({
          status: 404,
          code: ErrorCode.NOT_FOUND,
          detail: `Belief 不存在：${id}`,
          requestId: request.id,
        }),
      );
    }

    // provenance 锚点：项目专用修正会话（找不到则建）+ 一条 user 消息
    const [existingConv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.projectId, belief.projectId),
          eq(conversations.title, CORRECTIONS_CONVERSATION_TITLE),
        ),
      )
      .limit(1);
    const conversationId = existingConv?.id ?? uuidv7();
    if (!existingConv) {
      await db.insert(conversations).values({
        id: conversationId,
        projectId: belief.projectId,
        title: CORRECTIONS_CONVERSATION_TITLE,
      });
    }
    const messageId = uuidv7();
    await db.insert(messages).values({
      id: messageId,
      conversationId,
      speaker: "user",
      rawText: `人工修正：${belief.subject} / ${belief.attribute} → ${parsed.data.value}`,
      msgTime: new Date(),
    });

    // 走标准写入链（#16 去重分流 → #5 Resolver，意图 CORRECT + 权威 USER_CORRECTION）
    const result = await ingestCandidate(db, belief.projectId, {
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
    }, messageId);

    return { beliefId: result.beliefId, route: result.route, relation: result.relation };
  });
}
