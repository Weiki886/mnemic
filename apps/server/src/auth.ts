import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ErrorCode, problem } from "@mnemic/shared";
import { resolveAuthToken } from "./config.js";

/** 全局 onRequest：先鉴权再解析请求体/访问数据库或调用模型。 */
export function registerBearerAuth(app: FastifyInstance, token: string, corsOrigin?: string): void {
  const expected = createHash("sha256").update(resolveAuthToken(token)).digest();
  app.addHook("onRequest", async (request, reply) => {
    const path = request.raw.url?.split("?")[0];
    if ((request.method === "GET" || request.method === "HEAD") && path === "/health") return;
    // 浏览器预检不携带 Token；仅协商传输头，CORS 插件返回 204，不执行业务处理器。
    if (
      corsOrigin &&
      request.method === "OPTIONS" &&
      request.headers.origin === corsOrigin &&
      /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(
        request.headers["access-control-request-method"] ?? "",
      )
    )
      return;
    const header = request.headers.authorization;
    const match = typeof header === "string" && /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
    if (match && timingSafeEqual(expected, createHash("sha256").update(match[1]!).digest())) return;
    // 提前拒绝不会进入 CORS 插件；可信 Web 源也必须能读取结构化 401，而非只见 Fetch 错误。
    if (corsOrigin && request.headers.origin === corsOrigin) {
      reply.header("access-control-allow-origin", corsOrigin).header("vary", "Origin");
    }
    return reply
      .code(401)
      .type("application/problem+json")
      .header("www-authenticate", 'Bearer realm="mnemic"')
      .header("cache-control", "no-store")
      .send(
        problem({
          status: 401,
          code: ErrorCode.UNAUTHORIZED,
          detail: "需要有效的 Bearer Token",
          requestId: request.id,
        }),
      );
  });
}
