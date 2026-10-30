import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { UsageTimeSchema } from "@mnemic/shared/usage";
import { usageWindow } from "../usage/pricing.js";
import { publicAuditRow } from "./events.js";
const uuid = z.string().uuid().toLowerCase();
const Query = z
  .object({
    from: UsageTimeSchema.optional(),
    to: UsageTimeSchema.optional(),
    after: uuid.optional(),
    limit: z
      .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
      .pipe(z.number().int().min(1).max(200))
      .default(50),
    actor: z.enum(["server", "cli", "gate"]).optional(),
    action: z
      .enum([
        "provider.create",
        "provider.update",
        "flags.update",
        "belief.delete",
        "belief.restore",
        "usage.export",
        "redact",
        "approval.file.read",
        "approval.file.create",
        "approval.file.overwrite",
        "approval.file.delete",
        "approval.shell",
        "approval.invalid",
      ])
      .optional(),
    target: z
      .union([
        uuid,
        z.literal("server"),
        z.string().regex(/^sha256:[a-f0-9]{64}$/),
        z.enum([
          "candidate.value",
          "candidate.subject",
          "candidate.attribute",
          "candidate.entities",
        ]),
      ])
      .optional(),
    project_id: uuid.optional(),
  })
  .strict();
/** Global operator-only read API. Root Bearer hook precedes query validation/DB access. */
export function registerAuditRoutes(app: FastifyInstance, db: PostgresJsDatabase) {
  app.get(
    "/v1/audit-log",
    {
      onRequest: async (_req, reply) => {
        reply.header("cache-control", "no-store");
      },
    },
    async (request, reply) => {
      const parsed = Query.safeParse(request.query);
      const bad = (error: z.ZodError) =>
        reply
          .code(400)
          .type("application/problem+json")
          .send(
            problem({
              status: 400,
              code: ErrorCode.VALIDATION_FAILED,
              detail: "审计查询参数非法；时间范围须大于0且不超过366天",
              requestId: request.id,
              errors: zodIssues(error),
            }),
          );
      if (!parsed.success) return bad(parsed.error);
      const q = parsed.data;
      let window: ReturnType<typeof usageWindow>;
      try {
        window = usageWindow(q);
      } catch {
        return bad(
          new z.ZodError([
            { code: "custom", path: ["from"], message: "时间范围须大于0且不超过366天" },
          ]),
        );
      }
      const where = sql`ts >= ${window.from}::timestamptz and ts < ${window.to}::timestamptz
    ${q.actor ? sql`and actor=${q.actor}` : sql``}
    ${q.action ? sql`and action=${q.action}` : sql``}
    ${q.target ? sql`and target=${q.target}` : sql``}
    ${q.project_id ? sql`and meta->>'project_id'=${q.project_id}` : sql``}`;
      let cursor = sql``;
      if (q.after) {
        const [row] = await db.execute(
          sql`select ts::text as point from audit_log where ${where} and id=${q.after}::uuid`,
        );
        if (!row)
          return reply
            .code(404)
            .type("application/problem+json")
            .send(
              problem({
                status: 404,
                code: ErrorCode.NOT_FOUND,
                detail: "当前筛选范围内未找到审计游标",
                requestId: request.id,
              }),
            );
        cursor = sql`and (ts,id)>(${row.point}::timestamptz,${q.after}::uuid)`;
      }
      const rows = await db.execute<{
        id: string;
        ts: string;
        actor: unknown;
        action: unknown;
        target: unknown;
        decision: unknown;
        meta: unknown;
      }>(sql`
    select id,to_char(ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts,
      case when octet_length(actor)<=64 then actor else null end as actor,
      case when octet_length(action)<=64 then action else null end as action,
      case when octet_length(target)<=128 then target else null end as target,
      case when octet_length(decision)<=64 then decision else null end as decision,
      case when octet_length(meta::text)<=65536 then meta else null end as meta
    from audit_log where ${where} ${cursor} order by audit_log.ts,id limit ${q.limit + 1}`);
      return {
        ...window,
        limit: q.limit,
        items: rows.slice(0, q.limit).map(publicAuditRow),
        next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    },
  );
}
