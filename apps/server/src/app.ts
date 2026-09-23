import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { stdSerializers } from "pino";
import { ErrorCode, problem } from "@mnemic/shared";
import { registerProviderRoutes } from "./providers/routes.js";
import { registerGateRoutes } from "./gate/routes.js";
import { registerBeliefRoutes } from "./beliefs/correct-route.js";

export interface BuildAppOptions {
  /** 测试用：自定义日志输出流 */
  logStream?: { write: (chunk: string) => void };
  /** 配置后注册 Providers 配置 API（#14）；二者缺一不注册 */
  db?: PostgresJsDatabase | undefined;
  masterKey?: Buffer | undefined;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Fastify 默认 req 序列化不含 headers，redact 会落空；显式带上 headers，让脱敏真实生效
      serializers: {
        req: (req): Record<string, unknown> => ({ ...stdSerializers.req(req.raw) }),
      },
      redact: {
        paths: ["req.headers.authorization", 'res.headers["set-cookie"]'],
        censor: "[REDACTED]",
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    // 请求 ID：上游传入则透传，否则生成 UUID（贯穿日志与响应头）
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.get("/health", async () => ({ status: "ok" }));

  if (options.db && options.masterKey) {
    registerProviderRoutes(app, options.db, options.masterKey);
  }
  if (options.db) {
    registerGateRoutes(app, options.db);
    registerBeliefRoutes(app, options.db);
  }

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .header("content-type", "application/problem+json")
      .send(
        problem({
          status: 404,
          code: ErrorCode.NOT_FOUND,
          detail: `路由不存在：${request.method} ${request.url}`,
          requestId: request.id,
        }),
      );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled error");
    }
    const code =
      status === 400
        ? ErrorCode.VALIDATION_FAILED
        : status === 401
          ? ErrorCode.UNAUTHORIZED
          : status === 404
            ? ErrorCode.NOT_FOUND
            : ErrorCode.INTERNAL_ERROR;
    reply
      .code(status)
      .header("content-type", "application/problem+json")
      .send(
        problem({
          status,
          code,
          // 5xx 不回传内部细节，避免泄露实现
          detail: status >= 500 ? "服务器内部错误" : error.message,
          requestId: request.id,
        }),
      );
  });

  return app;
}
