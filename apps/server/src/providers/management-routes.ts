import type { FastifyInstance, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import {
  ConfigSchema,
  ProjectStatusSchema,
  ProviderConfigSchema,
  ProviderPatchSchema,
} from "@mnemic/shared/management";
import { beliefs, conversations, projects, providerConfigs } from "../db/schema.js";
import { selectSlotProvider } from "./selection.js";
import type { ModelSlots } from "./repository.js";
type Db = PostgresJsDatabase;
const UUID = z.string().uuid();
function fail(
  reply: FastifyReply,
  requestId: string,
  status: number,
  code: ErrorCode,
  detail: string,
  error?: z.ZodError,
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(
      problem({ status, code, detail, requestId, ...(error ? { errors: zodIssues(error) } : {}) }),
    );
}
function safeUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
function publicRow(row: {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  models: unknown;
  createdAt: Date;
}) {
  return ProviderConfigSchema.parse({
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    base_url: safeUrl(row.baseUrl),
    models: row.models,
    created_at: row.createdAt.toISOString(),
  });
}
/** 不解密、不构造 SDK，不返回任何密钥（包括掩码）。 */
async function snapshot(db: Db) {
  const rows = await db
    .select({
      id: providerConfigs.id,
      name: providerConfigs.name,
      protocol: providerConfigs.protocol,
      baseUrl: providerConfigs.baseUrl,
      models: providerConfigs.models,
      createdAt: providerConfigs.createdAt,
    })
    .from(providerConfigs)
    .orderBy(asc(providerConfigs.createdAt), asc(providerConfigs.id))
    .limit(1001);
  if (rows.length > 1000) throw new Error("too many providers");
  const slot = (name: keyof ModelSlots) => {
    const p = selectSlotProvider(rows, name);
    return p
      ? { provider_id: p.id, provider_name: p.name, model: (p.models as ModelSlots)[name] }
      : null;
  };
  return ConfigSchema.parse({
    config_source: "server",
    providers: rows.map(publicRow),
    slots: { chat: slot("chat"), extraction: slot("extraction"), embedding: slot("embedding") },
  });
}

export function registerManagementRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/config", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const query = z.object({}).strict().safeParse(request.query);
    if (!query.success)
      return fail(
        reply,
        request.id,
        400,
        ErrorCode.VALIDATION_FAILED,
        "配置读取不接受查询参数",
        query.error,
      );
    return snapshot(db);
  });
  app.get("/projects/:projectId/status", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ projectId: UUID }).safeParse(request.params);
    const query = z.object({ conversation_id: UUID }).strict().safeParse(request.query);
    if (!params.success || !query.success)
      return fail(
        reply,
        request.id,
        400,
        ErrorCode.VALIDATION_FAILED,
        "项目/会话参数无效",
        !params.success ? params.error : !query.success ? query.error : undefined,
      );
    const projectId = params.data.projectId;
    const [row] = await db
      .select({
        project: { id: projects.id, name: projects.name },
        conversation: { id: conversations.id, endedAt: conversations.endedAt },
      })
      .from(conversations)
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .where(
        and(
          eq(conversations.id, query.data.conversation_id),
          eq(conversations.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) return fail(reply, request.id, 404, ErrorCode.NOT_FOUND, "当前项目或会话不存在");
    const counts = { total: 0, active: 0, deleted: 0, retracted: 0, superseded: 0, expired: 0 };
    const groups = await db
      .select({ status: beliefs.status, n: sql<string>`count(*)` })
      .from(beliefs)
      .where(eq(beliefs.projectId, projectId))
      .groupBy(beliefs.status);
    for (const g of groups) {
      counts[g.status] = Number(g.n);
      counts.total += Number(g.n);
    }
    return ProjectStatusSchema.parse({
      project: row.project,
      conversation: {
        id: row.conversation.id,
        ended_at: row.conversation.endedAt?.toISOString() ?? null,
      },
      counts,
      slots: (await snapshot(db)).slots,
    });
  });
  app.patch("/providers/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ id: UUID }).safeParse(request.params);
    const body = ProviderPatchSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return fail(
        reply,
        request.id,
        400,
        ErrorCode.VALIDATION_FAILED,
        "仅允许修改已有 Provider 元数据及 chat/extraction 槽位；embedding 需 REEMBED",
        !params.success ? params.error : !body.success ? body.error : undefined,
      );
    const p = body.data;
    try {
      const result = await db.transaction(async (tx) => {
        const [old] = await tx
          .select()
          .from(providerConfigs)
          .where(eq(providerConfigs.id, params.data.id))
          .for("update");
        if (!old) return { kind: "missing" } as const;
        if (
          (old.models as ModelSlots).embedding !== undefined &&
          ((p.base_url !== undefined && p.base_url !== old.baseUrl) ||
            (p.protocol !== undefined && p.protocol !== old.protocol))
        )
          return { kind: "embedding" } as const;
        const [updated] = await tx
          .update(providerConfigs)
          .set({
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
            ...(p.base_url !== undefined ? { baseUrl: p.base_url } : {}),
            ...(p.models
              ? { models: sql`${providerConfigs.models} || ${JSON.stringify(p.models)}::jsonb` }
              : {}),
          })
          .where(eq(providerConfigs.id, params.data.id))
          .returning();
        return { kind: "ok", value: publicRow(updated!) } as const;
      });
      if (result.kind === "missing")
        return fail(reply, request.id, 404, ErrorCode.NOT_FOUND, "Provider 不存在");
      if (result.kind === "embedding")
        return fail(
          reply,
          request.id,
          409,
          ErrorCode.CONFLICT,
          "该 Provider 承载 embedding；端点/协议变更需 REEMBED 流程",
        );
      return result.value;
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      if (e.code === "23505" || e.cause?.code === "23505")
        return fail(reply, request.id, 409, ErrorCode.CONFLICT, "Provider 名称已存在");
      return fail(reply, request.id, 500, ErrorCode.INTERNAL_ERROR, "配置修改未确认；不会自动重试");
    }
  });
}
