import type { FastifyInstance, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { FeatureFlagUpdateSchema } from "@mnemic/shared/flags";
import { ErrorCode, problem, zodIssues, type FieldError } from "@mnemic/shared";
import {
  FeatureFlagRevisionExhaustedError,
  readFeatureFlags,
  updateFeatureFlags,
} from "./repository.js";
import { UNSUPPORTED_FEATURE_FLAGS } from "./runtime.js";
const Query = z.object({}).strict();
function fail(
  reply: FastifyReply,
  requestId: string,
  status: 400 | 409 | 415,
  detail: string,
  errors?: FieldError[],
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(
      problem({
        status,
        code: status === 409 ? ErrorCode.CONFLICT : ErrorCode.VALIDATION_FAILED,
        detail,
        requestId,
        ...(errors ? { errors } : {}),
      }),
    );
}
/** Operator-wide configuration. Global Bearer authentication runs before this plugin's hooks. */
export function registerFeatureFlagRoutes(app: FastifyInstance, db: PostgresJsDatabase): void {
  const readQuery = (query: unknown) => Query.safeParse(query);
  app.get(
    "/v1/config/flags",
    {
      onRequest: async (_request, reply) => {
        reply.header("cache-control", "no-store");
      },
    },
    async (request, reply) => {
      const query = readQuery(request.query);
      if (!query.success)
        return fail(reply, request.id, 400, "开关配置不接受查询参数", zodIssues(query.error));
      return readFeatureFlags(db);
    },
  );
  app.put(
    "/v1/config/flags",
    {
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
          return fail(reply, request.id, 415, "开关更新要求 Content-Type: application/json");
      },
    },
    async (request, reply) => {
      const query = readQuery(request.query);
      if (!query.success)
        return fail(reply, request.id, 400, "开关配置不接受查询参数", zodIssues(query.error));
      const body = FeatureFlagUpdateSchema.safeParse(request.body);
      if (!body.success)
        return fail(reply, request.id, 400, "开关更新参数非法", zodIssues(body.error));
      const unsupported = UNSUPPORTED_FEATURE_FLAGS.filter((key) => body.data.flags[key]);
      if (unsupported.length)
        return fail(
          reply,
          request.id,
          400,
          "存在尚未支持的开关",
          unsupported.map((key) => ({
            path: `flags.${key}`,
            message: "当前版本尚不支持启用此开关",
          })),
        );
      try {
        const result = await updateFeatureFlags(db, body.data);
        if (result.kind === "conflict")
          return fail(reply, request.id, 409, "配置已变更，请重新读取后再提交", [
            { path: "expected_revision", message: "版本不匹配，请刷新配置" },
          ]);
        return result;
      } catch (error) {
        if (error instanceof FeatureFlagRevisionExhaustedError)
          return fail(reply, request.id, 409, "配置版本号已耗尽，无法继续修改", [
            { path: "expected_revision", message: "配置版本号已耗尽" },
          ]);
        throw error;
      }
    },
  );
}
