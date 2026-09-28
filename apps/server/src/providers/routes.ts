import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { createProvider, listProviders } from "./repository.js";

/**
 * Providers 配置 API（#14，ADR-005 配置单源：Web/CLI 共享这一套）。
 * 铁律：任何响应不得包含 Key 明文或密文（掩码视图由仓储层保证）。
 * 鉴权归 #20（最小 Bearer），本 Issue 窗口期无鉴权——PR 已显式标注。
 */

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  protocol: z.enum(["openai-compatible", "anthropic"]),
  base_url: z.string().url(),
  api_key: z.string().min(8),
  models: z
    .object({
      chat: z.string().min(1).optional(),
      extraction: z.string().min(1).optional(),
      embedding: z.string().min(1).optional(),
    })
    .refine((m) => m.chat || m.extraction || m.embedding, {
      message: "至少配置一个槽位",
    }),
});

export function registerProviderRoutes(
  app: FastifyInstance,
  db: PostgresJsDatabase,
  masterKey: Buffer,
): void {
  app.post("/providers", async (request, reply) => {
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).header("content-type", "application/problem+json").send(
        problem({
          status: 400,
          code: ErrorCode.VALIDATION_FAILED,
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
          errors: zodIssues(parsed.error),
          requestId: request.id,
        }),
      );
    }
    const { base_url, api_key, ...rest } = parsed.data;
    try {
      const created = await createProvider(db, masterKey, {
        ...rest,
        baseUrl: base_url,
        apiKey: api_key,
      });
      return reply.code(201).send(created);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).header("content-type", "application/problem+json").send(
          problem({
            status: 409,
            code: ErrorCode.CONFLICT,
            detail: `Provider 名称已存在：${parsed.data.name}`,
            requestId: request.id,
          }),
        );
      }
      throw err;
    }
  });

  app.get("/providers", async () => {
    return listProviders(db, masterKey);
  });
}
