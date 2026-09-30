import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { stdSerializers } from "pino";
import { ErrorCode, problem } from "@mnemic/shared";
import { registerProviderRoutes } from "./providers/routes.js";
import { registerGateRoutes } from "./gate/routes.js";
import { registerBeliefRoutes } from "./beliefs/correct-route.js";
import { registerBeliefReadRoutes } from "./beliefs/read-routes.js";
import { registerChatRoutes } from "./chat/routes.js";
import { registerConversationReadRoutes } from "./chat/read-routes.js";
import { waitForChatJobs } from "./chat/jobs.js";
import type { ProviderFactory } from "./providers/factory.js";
import type { retrieve } from "./retrieval/search.js";

/** 明确映射的状态码 → 错误码；未列出的按 >=500 / 其余 4xx 两个兜底分支处理 */
const ERROR_CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
};

export interface BuildAppOptions {
  /** 测试用：自定义日志输出流 */
  logStream?: { write: (chunk: string) => void };
  /** 配置后注册 Providers 配置 API（#14）；二者缺一不注册 */
  db?: PostgresJsDatabase | undefined;
  masterKey?: Buffer | undefined;
  /** 测试注入 Fake 模型工厂（#7 对话闭环等模型消费者共用） */
  providerFactory?: ProviderFactory | undefined;
  /** 对话闭环附加依赖（测试注入检索替身） */
  chatDeps?: { retrieveFn?: typeof retrieve } | undefined;
  /** 停机等待异步写回任务的超时上限（毫秒），默认 10s；测试可调小 */
  shutdownDrainMs?: number | undefined;
}

/** 停机排空写回任务的默认超时：覆盖批提取的正常耗时，又不至于让停机无限悬挂 */
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Fastify 默认 req 序列化不含 headers，redact 会落空；显式带上 headers，让脱敏真实生效
      serializers: {
        req: (req): Record<string, unknown> => ({ ...stdSerializers.req(req.raw) }),
      },
      // res 只序列化 statusCode，配 res.headers.* 永远匹配不到，不放摆设条目（#62）
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]'],
        censor: "[REDACTED]",
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    // 请求 ID：上游传入且形态合法才透传（防日志放大/伪造），否则生成 UUID（贯穿日志与响应头）
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w.-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // 优雅停机衔接异步写回（#62）：app.close() 先等 chat commit 的 pending
  // 写回任务排空，否则刚返回成功的 commit 在停机时静默丢失；挂死任务超时放行
  app.addHook("onClose", async () => {
    const drainMs = options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        waitForChatJobs(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            app.log.warn({ drainMs }, "shutdown drain timeout: pending writeback jobs abandoned");
            resolve();
          }, drainMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  if (options.db && options.masterKey) {
    registerProviderRoutes(app, options.db, options.masterKey);
  }
  if (options.db) {
    registerGateRoutes(app, options.db);
    registerBeliefRoutes(app, options.db);
    registerBeliefReadRoutes(app, options.db);
    registerConversationReadRoutes(app, options.db);
  }
  if (options.db && options.masterKey) {
    registerChatRoutes(app, options.db, options.masterKey, {
      ...(options.providerFactory ? { factory: options.providerFactory } : {}),
      ...(options.chatDeps?.retrieveFn ? { retrieveFn: options.chatDeps.retrieveFn } : {}),
    });
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
      ERROR_CODE_BY_STATUS[status] ??
      (status >= 500
        ? ErrorCode.INTERNAL_ERROR
        : // 其余 4xx（413/415/405 等）均为客户端错误类，绝不能标成 INTERNAL_ERROR
          ErrorCode.VALIDATION_FAILED);
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
