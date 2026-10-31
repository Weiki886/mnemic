import { HealthResponseSchema } from "./contracts/health.js";
import { registerAuditRoutes } from "./audit/routes.js";
import { RetryError } from "ai";
import { createModelQuota, DailyCallLimit, ModelQuotaError } from "./quota/repository.js";
import { createRequestRateLimits, type RequestRateLimitOptions } from "./rate-limit.js";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
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
import { registerDoctorRoutes } from "./doctor/routes.js";
import { registerRecallRoutes } from "./retrieval/routes.js";
import { registerManagementRoutes } from "./providers/management-routes.js";
import { registerBearerAuth } from "./auth.js";
import { resolveAuthToken } from "./config.js";
import { registerApprovalAuditRoutes } from "./approval/routes.js";
import { registerFeatureFlagRoutes } from "./flags/routes.js";
import { registerUsageRoutes } from "./usage/routes.js";
import type { UsagePricing } from "./usage/pricing.js";
import { sanitizeText } from "./gate/secrets.js";
import { createModelDebug } from "./debug/model-content.js";
import { createMemoryWorker, type ExtractionQueueOptions } from "./tasks/memory-worker.js";
import type { TaskWorker } from "./tasks/worker.js";
import { createDebugTrace } from "./debug/trace.js";

/** 明确映射的状态码 → 错误码；未列出的按 >=500 / 其余 4xx 两个兜底分支处理 */
const ERROR_CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

export interface BuildAppOptions {
  /** Library opt-in; official entry always supplies a validated daily limit. */
  modelDailyCallLimit?: number;
  /** Per-instance token buckets. Official entry uses defaults; no HTTP/env disable switch. */
  rateLimit?: RequestRateLimitOptions | undefined;
  /** Operator-only; forces debug-level output. LOG_LEVEL alone never enables memory traces. */
  debugMode?: boolean;
  debugContent?: boolean;
  usagePricing?: UsagePricing;
  /** 默认必须提供 Token；仅隔离测试夹具可显式 auth:false。正式入口没有关闭开关。 */
  authToken?: string | undefined;
  auth?: boolean | undefined;
  /** 测试用：自定义日志输出流 */
  logStream?: { write: (chunk: string) => void };
  /** 配置后注册 Providers 配置 API（#14）；二者缺一不注册 */
  db?: PostgresJsDatabase | undefined;
  masterKey?: Buffer | undefined;
  /** 测试注入 Fake 模型工厂（#7 对话闭环等模型消费者共用） */
  providerFactory?: ProviderFactory | undefined;
  /** 对话闭环附加依赖（测试注入检索替身） */
  chatDeps?: { retrieveFn?: typeof retrieve; streamTimeoutMs?: number } | undefined;
  /** 停机等待异步写回任务的超时上限（毫秒），默认 10s；测试可调小 */
  shutdownDrainMs?: number | undefined;
  /** Library opt-in; official server enables durable extraction whenever DB + master key are configured. */
  extractionQueue?: ExtractionQueueOptions;
  /** Explicit externally managed engine; mutually exclusive with extractionQueue. */
  taskWorker?: Pick<TaskWorker, "start" | "stop">;
  /** CORS 允许的源（#8 Web 记忆中心跨源调 API）；未配置则不启用 CORS */
  corsOrigin?: string | undefined;
}

/** 停机排空写回任务的默认超时：覆盖批提取的正常耗时，又不至于让停机无限悬挂 */
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  if (options.debugContent && !options.debugMode)
    throw new Error("MNEMIC_DEBUG_CONTENT requires MNEMIC_DEBUG=1");
  if (options.extractionQueue && (!options.db || !options.masterKey))
    throw Error("durable extraction requires database and master key");
  if (options.extractionQueue && options.taskWorker) throw Error("choose one managed task worker");
  const drainMs = options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
  if (
    (options.taskWorker || options.extractionQueue) &&
    (!Number.isInteger(drainMs) || drainMs < 0 || drainMs > 60000)
  )
    throw new Error("managed worker shutdownDrainMs must be an integer from 0 to 60000");
  const dailyLimit =
    options.modelDailyCallLimit === undefined
      ? undefined
      : DailyCallLimit.parse(options.modelDailyCallLimit);
  if (dailyLimit !== undefined && !options.db) throw Error("model daily quota requires database");
  const authToken = options.auth === false ? undefined : resolveAuthToken(options.authToken);
  const rateLimits = createRequestRateLimits(options.rateLimit, options.corsOrigin);
  const app = Fastify({
    logger: {
      level: options.debugMode ? "debug" : (process.env.LOG_LEVEL ?? "info"),
      // Fastify 默认 req 序列化不含 headers，redact 会落空；显式带上 headers，让脱敏真实生效
      serializers: {
        req: (req): Record<string, unknown> => ({
          method: req.method,
          remoteAddress: req.raw.socket.remoteAddress,
          // Do not serialize arbitrary headers: unknown credential names have no reliable regex.
          headers: Object.fromEntries(
            ["authorization", "cookie", "x-api-key"]
              .filter((name) => req.headers[name] !== undefined)
              .map((name) => [name, "[REDACTED]"]),
          ),
          // 不记录任何查询值，避免误放进 URL 的 Token/凭据进入访问日志。
          url: sanitizeText(req.raw.url?.split("?")[0] ?? "").text,
        }),
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
      return typeof incoming === "string" &&
        /^[\w.-]{1,128}$/.test(incoming) &&
        sanitizeText(incoming).hits.length === 0
        ? incoming
        : randomUUID();
    },
  });

  const admitModelCall =
    dailyLimit === undefined ? undefined : createModelQuota(options.db!, dailyLimit, app.log);
  const quotaOptions = admitModelCall ? { admitModelCall } : {};
  const debugTrace = createDebugTrace(options.debugMode ? app.log : undefined);
  const modelDebug = options.debugContent
    ? createModelDebug(app.log, [
        ...(authToken ? [authToken] : []),
        ...(options.masterKey
          ? [
              options.masterKey.toString("hex"),
              options.masterKey.toString("hex").toUpperCase(),
              options.masterKey.toString("base64"),
            ]
          : []),
      ])
    : undefined;
  const taskWorker = options.extractionQueue
    ? createMemoryWorker(
        options.db!,
        options.masterKey!,
        options.extractionQueue,
        {
          debugTrace,
          ...(modelDebug ? { modelDebug } : {}),
          usageLogger: app.log,
          ...quotaOptions,
          ...(options.providerFactory ? { factory: options.providerFactory } : {}),
        },
        { warn: (msg) => app.log.warn(msg) },
      )
    : options.taskWorker;
  app.addHook("onRequest", rateLimits.ip);
  if (authToken !== undefined) {
    registerBearerAuth(app, authToken, options.corsOrigin);
    app.addHook("onRequest", rateLimits.token);
  }
  if (options.corsOrigin) {
    app.register(cors, {
      origin: options.corsOrigin,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["authorization", "content-type"],
    });
  }

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  if (taskWorker)
    app.addHook("onReady", async () => {
      taskWorker.start();
    });

  // 优雅停机衔接异步写回（#62）：app.close() 先等 chat commit 的 pending
  // 写回任务排空，否则刚返回成功的 commit 在停机时静默丢失；挂死任务超时放行
  app.addHook("onClose", async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          if (taskWorker) {
            try {
              const result = await taskWorker.stop(drainMs);
              if (!result.drained) app.log.warn("task worker shutdown drain timeout");
            } catch {
              app.log.warn("task worker shutdown failed");
            }
          }
          await waitForChatJobs();
        })(),
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

  app.get("/health", async () => HealthResponseSchema.parse({ status: "ok" }));
  registerDoctorRoutes(app, {
    ...quotaOptions,
    authenticated: authToken !== undefined,
    db: options.db,
    masterKey: options.masterKey,
    factory: options.providerFactory,
  });

  if (options.db && options.masterKey) {
    registerProviderRoutes(app, options.db, options.masterKey);
    registerRecallRoutes(
      app,
      options.db,
      options.masterKey,
      options.providerFactory,
      debugTrace,
      admitModelCall,
    );
  }
  if (options.db) {
    registerAuditRoutes(app, options.db);
    registerFeatureFlagRoutes(app, options.db);
    registerUsageRoutes(app, options.db, options.usagePricing);
    registerApprovalAuditRoutes(app, options.db);
    registerManagementRoutes(app, options.db);
    registerGateRoutes(app, options.db, debugTrace);
    registerBeliefRoutes(app, options.db, debugTrace);
    registerBeliefReadRoutes(app, options.db, debugTrace);
    registerConversationReadRoutes(app, options.db);
  }
  if (options.db && options.masterKey) {
    registerChatRoutes(app, options.db, options.masterKey, {
      ...quotaOptions,
      ...(options.extractionQueue ? { durableExtraction: true } : {}),
      debugTrace,
      ...(modelDebug ? { modelDebug } : {}),
      ...(options.providerFactory ? { factory: options.providerFactory } : {}),
      ...(options.chatDeps?.retrieveFn ? { retrieveFn: options.chatDeps.retrieveFn } : {}),
      ...(options.chatDeps?.streamTimeoutMs !== undefined
        ? { streamTimeoutMs: options.chatDeps.streamTimeoutMs }
        : {}),
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
          detail: `路由不存在：${request.method} ${request.url.split("?")[0]}`,
          requestId: request.id,
        }),
      );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // SDK retries wrap the final local denial; only unwrap this known SDK error shape.
    const quotaError =
      error instanceof ModelQuotaError
        ? error
        : RetryError.isInstance(error) && error.lastError instanceof ModelQuotaError
          ? error.lastError
          : undefined;
    const status =
      quotaError?.statusCode ??
      (error.statusCode && error.statusCode >= 400 ? error.statusCode : 500);
    if (status >= 500) {
      request.log.error({ statusCode: status }, "unhandled error");
    }
    if (quotaError)
      reply
        .header("cache-control", "no-store")
        .header("retry-after", String(quotaError.retryAfterSeconds));
    const code = quotaError
      ? quotaError.reason === "exhausted"
        ? ErrorCode.MODEL_QUOTA_EXCEEDED
        : ErrorCode.MODEL_QUOTA_UNAVAILABLE
      : (ERROR_CODE_BY_STATUS[status] ??
        (status >= 500
          ? ErrorCode.INTERNAL_ERROR
          : // 其余 4xx（413/415/405 等）均为客户端错误类，绝不能标成 INTERNAL_ERROR
            ErrorCode.VALIDATION_FAILED));
    reply
      .code(status)
      .header("content-type", "application/problem+json")
      .send(
        problem({
          status,
          code,
          // 5xx 不回传内部细节，避免泄露实现
          detail: quotaError
            ? quotaError.message
            : status >= 500
              ? "服务器内部错误"
              : error.message,
          requestId: request.id,
        }),
      );
  });

  return app;
}
