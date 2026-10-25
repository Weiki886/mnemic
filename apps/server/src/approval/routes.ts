import type { FastifyInstance, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import {
  ApprovalAuditEventSchema,
  ApprovalAuditQuerySchema,
  type ApprovalAuditEvent,
} from "@mnemic/shared/approval-audit";
import { auditLog, projects } from "../db/schema.js";

const Params = z.object({ projectId: z.string().uuid().toLowerCase() }).strict();
function fail(
  reply: FastifyReply,
  requestId: string,
  status: 400 | 404 | 409,
  detail: string,
  error?: z.ZodError,
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(
      problem({
        status,
        code:
          status === 400
            ? ErrorCode.VALIDATION_FAILED
            : status === 404
              ? ErrorCode.NOT_FOUND
              : ErrorCode.CONFLICT,
        detail,
        requestId,
        ...(error ? { errors: zodIssues(error) } : {}),
      }),
    );
}
const action = (event: ApprovalAuditEvent) => `approval.${event.operation ?? "invalid"}`;
const target = (event: ApprovalAuditEvent) =>
  event.target_hash ? `sha256:${event.target_hash}` : null;
type Row = typeof auditLog.$inferSelect;
function publicRow(row: Row) {
  const { client_reported, version, ...raw } = row.meta as Record<string, unknown>;
  const event = ApprovalAuditEventSchema.parse(raw);
  if (
    client_reported !== true ||
    version !== 1 ||
    row.actor !== "cli" ||
    row.id !== event.event_id ||
    row.action !== action(event) ||
    row.target !== target(event) ||
    row.decision !== event.decision
  )
    throw new Error("审批审计记录格式不兼容");
  return { event, recorded_at: row.ts.toISOString() };
}

/** Client-reported decision history, NOT evidence of tool execution or remote authorization. */
export function registerApprovalAuditRoutes(app: FastifyInstance, db: PostgresJsDatabase): void {
  app.post("/projects/:projectId/approvals", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = Params.safeParse(request.params),
      body = ApprovalAuditEventSchema.safeParse(request.body);
    if (!params.success) return fail(reply, request.id, 400, "项目参数无效", params.error);
    if (!body.success) return fail(reply, request.id, 400, "审批审计参数无效", body.error);
    const event = body.data;
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, params.data.projectId))
      .limit(1);
    if (!project || event.project_id !== project.id)
      return fail(reply, request.id, 404, "项目范围内未找到记录");
    // The generic gate writer creates new UUIDs; this writer uses the event UUID for safe ACK retries.
    const inserted = await db
      .insert(auditLog)
      .values({
        id: event.event_id,
        actor: "cli",
        action: action(event),
        target: target(event),
        decision: event.decision,
        meta: { ...event, client_reported: true, version: 1 },
      })
      .onConflictDoNothing({ target: auditLog.id })
      .returning();
    if (inserted[0]) return reply.code(201).send(publicRow(inserted[0]));
    const [existing] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, event.event_id))
      .limit(1);
    try {
      if (existing) {
        const record = publicRow(existing);
        if (JSON.stringify(record.event) === JSON.stringify(event)) return record;
      }
    } catch {
      /* A colliding platform event is not an approval receipt. */
    }
    return fail(reply, request.id, 409, "审计事件 ID 已用于其他内容");
  });
  app.get("/projects/:projectId/approvals", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = Params.safeParse(request.params),
      query = ApprovalAuditQuerySchema.safeParse(request.query);
    if (!params.success) return fail(reply, request.id, 400, "项目参数无效", params.error);
    if (!query.success) return fail(reply, request.id, 400, "分页参数无效", query.error);
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, params.data.projectId))
      .limit(1);
    if (!project) return fail(reply, request.id, 404, "项目范围内未找到记录");
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actor, "cli"),
          like(auditLog.action, "approval.%"),
          sql`${auditLog.meta}->>'project_id' = ${project.id}`,
          sql`${auditLog.meta}->>'client_reported' = 'true'`,
          sql`${auditLog.meta}->>'version' = '1'`,
        ),
      )
      .orderBy(asc(auditLog.ts), asc(auditLog.id))
      .limit(query.data.limit)
      .offset(query.data.offset);
    return { items: rows.map(publicRow), ...query.data };
  });
}
