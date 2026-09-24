import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode, problem, zodIssues } from "../src/errors.js";

describe("problem+json 统一错误模型", () => {
  it("产出 RFC 7807 必备字段与稳定错误码", () => {
    const body = problem({
      status: 404,
      code: ErrorCode.NOT_FOUND,
      detail: "belief 不存在",
      requestId: "req-1",
    });

    expect(body.type).toBe("about:blank");
    expect(body.title).toBe("Not Found");
    expect(body.status).toBe(404);
    expect(body.detail).toBe("belief 不存在");
    expect(body.code).toBe("NOT_FOUND");
    expect(body.requestId).toBe("req-1");
  });

  it("已知状态码映射标准 title", () => {
    expect(problem({ status: 400, code: ErrorCode.VALIDATION_FAILED }).title).toBe("Bad Request");
    expect(problem({ status: 401, code: ErrorCode.UNAUTHORIZED }).title).toBe("Unauthorized");
    expect(problem({ status: 500, code: ErrorCode.INTERNAL_ERROR }).title).toBe(
      "Internal Server Error",
    );
  });

  it("errors 扩展字段透传：客户端可直接定位字段级错误", () => {
    const body = problem({
      status: 400,
      code: ErrorCode.VALIDATION_FAILED,
      detail: "body.value 必须为字符串",
      errors: [{ path: "body.value", message: "必须为字符串" }],
    });
    expect(body.errors).toEqual([{ path: "body.value", message: "必须为字符串" }]);
  });

  it("zodIssues：ZodError 转为 {path, message} 数组（嵌套路径用点连接）", () => {
    const Schema = z.object({ name: z.string().min(1), nested: z.object({ age: z.number() }) });
    const r = Schema.safeParse({ name: 1, nested: {} });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issues = zodIssues(r.error);
      expect(issues).toContainEqual({ path: "name", message: expect.any(String) });
      expect(issues).toContainEqual({ path: "nested.age", message: expect.any(String) });
    }
  });
});
