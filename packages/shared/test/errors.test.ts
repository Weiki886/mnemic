import { describe, expect, it } from "vitest";
import { ErrorCode, problem } from "../src/errors.js";

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
});
