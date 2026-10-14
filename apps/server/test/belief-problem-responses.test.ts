import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as helpers from "../src/beliefs/problem-responses.js";

describe("beliefs 路由共用的 problem+json 响应", () => {
  it.each(["badRequest", "notFound", "conflict"] as const)(
    "%s 保持 HTTP 错误契约",
    async (kind) => {
      const parsed = z
        .object({ body: z.object({ name: z.string() }) })
        .safeParse({ body: { name: 42 } });
      if (parsed.success) throw new Error("测试输入应触发字段校验错误");
      const app = Fastify({ genReqId: () => "belief-errors-test" });
      app.get("/probe", (request, reply) => {
        if (kind === "badRequest")
          return helpers.badRequest(reply, request.id, "校验失败", parsed.error);
        if (kind === "notFound") return helpers.notFound(reply, request.id, "belief-missing");
        return helpers.conflict(reply, request.id, "当前状态不允许操作");
      });
      try {
        const response = await app.inject({ method: "GET", url: "/probe" });
        const expected = {
          badRequest: {
            status: 400,
            code: "VALIDATION_FAILED",
            title: "Bad Request",
            detail: "校验失败",
          },
          notFound: {
            status: 404,
            code: "NOT_FOUND",
            title: "Not Found",
            detail: "Belief 不存在：belief-missing",
          },
          conflict: {
            status: 409,
            code: "CONFLICT",
            title: "Conflict",
            detail: "当前状态不允许操作",
          },
        }[kind];
        expect(response.statusCode).toBe(expected.status);
        expect(response.headers["content-type"]).toContain("application/problem+json");
        expect(response.json()).toEqual({
          type: "about:blank",
          ...expected,
          requestId: "belief-errors-test",
          ...(kind === "badRequest"
            ? { errors: [{ path: "body.name", message: expect.any(String) }] }
            : {}),
        });
      } finally {
        await app.close();
      }
    },
  );
});
