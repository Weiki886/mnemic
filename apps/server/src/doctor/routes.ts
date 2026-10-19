import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { embed, generateText } from "ai";
import { z } from "zod";
import { ErrorCode, problem, zodIssues, type DoctorCheck, type DoctorReport } from "@mnemic/shared";
import { resolveModel, type Slot } from "../providers/slots.js";
import type { ProviderFactory } from "../providers/factory.js";
import { assertDimensionMatch, embeddingDimensionsFromEnv } from "../providers/dimension-guard.js";

interface DoctorOptions {
  authenticated?: boolean | undefined;
  db?: PostgresJsDatabase | undefined;
  masterKey?: Buffer | undefined;
  factory?: ProviderFactory | undefined;
}

const Query = z.object({}).strict();
const ProbeBody = z.object({}).strict();
const SLOTS = ["chat", "extraction", "embedding"] as const;

/** 诊断仅读取配置/数据库；显式 probe 才调用外部模型，不落 Evidence/Trace。 */
async function diagnose(options: DoctorOptions, probe: boolean): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    {
      name: "authentication",
      status: options.authenticated ? "ok" : "skipped",
      detail: options.authenticated
        ? "当前请求的 Bearer Token 已验证"
        : "测试夹具未启用鉴权，不能验证 Token",
    },
  ];
  const finish = (): DoctorReport => ({
    ok: !checks.some((c) => c.status === "error"),
    probe,
    configSource: "server",
    checks,
  });
  const { db, masterKey } = options;
  if (!db) {
    checks.push({ name: "database", status: "error", detail: "未配置数据库连接" });
  } else {
    try {
      await db.execute(sql`select 1`);
      checks.push({ name: "database", status: "ok", detail: "数据库连接可用" });
    } catch {
      checks.push({
        name: "database",
        status: "error",
        detail: "数据库连接失败，请检查服务端 DATABASE_URL",
      });
    }
  }
  if (!db || checks.some((c) => c.name === "database" && c.status === "error")) {
    checks.push({ name: "configuration", status: "error", detail: "无法读取服务端模型配置" });
    for (const name of ["embedding_dimensions", ...SLOTS] as const) {
      checks.push({ name, status: "skipped", detail: "数据库不可用，未执行检查" });
    }
    return finish();
  }

  let expected: number;
  try {
    expected = embeddingDimensionsFromEnv();
  } catch {
    checks.push({
      name: "embedding_dimensions",
      status: "error",
      detail: "MNEMIC_EMBEDDING_DIMENSIONS 必须为正整数，请检查服务端环境配置",
    });
    checks.push({ name: "configuration", status: "error", detail: "部署配置检查未通过" });
    for (const name of SLOTS)
      checks.push({ name, status: "skipped", detail: "部署维度错误，未探测模型" });
    return finish();
  }
  try {
    const rows = await db.execute<{ atttypmod: number }>(sql`
      select atttypmod from pg_attribute
      where attrelid = to_regclass('public.memory_embeddings') and attname = 'embedding'
    `);
    if (!rows[0]) throw new Error("missing column");
    assertDimensionMatch(rows[0].atttypmod, expected);
    checks.push({
      name: "embedding_dimensions",
      status: "ok",
      detail: `数据库与部署维度一致：${expected}`,
    });
  } catch {
    checks.push({
      name: "embedding_dimensions",
      status: "error",
      detail: "向量列缺失或部署维度不匹配，请检查迁移/REEMBED 配置",
    });
    checks.push({ name: "configuration", status: "error", detail: "部署配置检查未通过" });
    for (const name of SLOTS)
      checks.push({ name, status: "skipped", detail: "部署维度错误，未探测模型" });
    return finish();
  }
  if (!masterKey) {
    checks.push({
      name: "configuration",
      status: "error",
      detail: "未配置服务端主密钥，无法解析模型配置",
    });
    for (const name of SLOTS) checks.push({ name, status: "skipped", detail: "未解析槽位配置" });
    return finish();
  }
  const modelOptions = options.factory ? { factory: options.factory } : {};
  const inspect = async (slot: Slot): Promise<{ check: DoctorCheck; configured: boolean }> => {
    let configured = false;
    let metadata: { provider: string; model: string } | undefined;
    try {
      if (slot === "embedding") {
        const resolved = await resolveModel(db, masterKey, slot, modelOptions);
        metadata = { provider: resolved.providerName, model: resolved.modelId };
        configured = true;
        if (probe) {
          const result = await embed({
            model: resolved.model,
            value: "Mnemic diagnostic probe",
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(15_000),
          });
          assertDimensionMatch(result.embedding.length, expected);
          if (!result.embedding.every(Number.isFinite)) throw new Error("invalid vector");
        }
      } else {
        const resolved = await resolveModel(db, masterKey, slot, modelOptions);
        metadata = { provider: resolved.providerName, model: resolved.modelId };
        configured = true;
        if (probe)
          await generateText({
            model: resolved.model,
            prompt: "Reply OK.",
            maxOutputTokens: 8,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(15_000),
          });
      }
      return {
        configured,
        check: {
          name: slot,
          ...metadata,
          status: probe ? "ok" : "skipped",
          detail: probe
            ? "模型探测成功"
            : "配置已解析；未调用模型，使用 --probe 验证可用性（可能计费）",
        },
      };
    } catch {
      // 上游异常可能带 Authorization、URL、响应正文；禁止回传/记录原始异常。
      return {
        configured,
        check: {
          name: slot,
          ...metadata,
          status: "error",
          detail: configured
            ? "模型探测失败或向量维度不符，请检查端点、权限、额度与模型"
            : "槽位未配置、主密钥错误或协议配置不可用",
        },
      };
    }
  };
  const results = await Promise.all(SLOTS.map(inspect));
  checks.push({
    name: "configuration",
    status: results.every((r) => r.configured) ? "ok" : "error",
    detail: results.every((r) => r.configured)
      ? "三槽位读取服务端加密配置；客户端无需模型 Key"
      : "部分槽位未能解析，请检查服务端 Provider 配置",
  });
  checks.push(...results.map((r) => r.check));
  return finish();
}

export function registerDoctorRoutes(app: FastifyInstance, options: DoctorOptions): void {
  app.get("/v1/doctor", async (request, reply) => {
    const parsed = Query.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .type("application/problem+json")
        .send(
          problem({
            status: 400,
            code: ErrorCode.VALIDATION_FAILED,
            detail: "只读诊断不接受查询参数；模型探测需 POST /v1/doctor/probe",
            errors: zodIssues(parsed.error),
            requestId: request.id,
          }),
        );
    reply.header("cache-control", "no-store");
    return diagnose(options, false);
  });

  app.post(
    "/v1/doctor/probe",
    {
      onRequest: async (request, reply) => {
        // CLI 专用：Origin 连允许的 Web 源也拒绝，不能仅靠 CORS 隐藏响应。
        if (request.headers.origin !== undefined) {
          return reply
            .code(403)
            .type("application/problem+json")
            .send(
              problem({
                status: 403,
                code: ErrorCode.FORBIDDEN,
                requestId: request.id,
                detail: "模型探测仅支持 CLI，不接受浏览器 Origin 请求",
              }),
            );
        }
        // 在解析请求体前拒绝简单表单/text/plain；JSON charset 参数仍可接受。
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          return reply
            .code(415)
            .type("application/problem+json")
            .send(
              problem({
                status: 415,
                code: ErrorCode.VALIDATION_FAILED,
                requestId: request.id,
                detail: "模型探测要求 Content-Type: application/json",
              }),
            );
        }
      },
    },
    async (request, reply) => {
      const parsed = ProbeBody.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .type("application/problem+json")
          .send(
            problem({
              status: 400,
              code: ErrorCode.VALIDATION_FAILED,
              requestId: request.id,
              detail: "模型探测请求体必须为 JSON 空对象 {}",
              errors: zodIssues(parsed.error),
            }),
          );
      reply.header("cache-control", "no-store");
      return diagnose(options, true);
    },
  );
}
