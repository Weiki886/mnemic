import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("统一错误模型（problem+json）", () => {
  it("未知路由返回 404 problem+json 且含错误码与 requestId", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json();
    expect(body).toMatchObject({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    });
    expect(typeof body.requestId).toBe("string");
    await app.close();
  });

  it("路由抛错返回 500 problem+json 且不泄露内部堆栈", async () => {
    const app = buildApp();
    app.get("/boom", () => {
      throw new Error("secret internals");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(body)).not.toContain("secret internals");
    await app.close();
  });

  it("不支持的媒体类型返回 415，错误码为客户端类而非 INTERNAL_ERROR", async () => {
    const app = buildApp();
    app.post("/echo", async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "text/xml" },
      payload: "<x/>",
    });
    expect(res.statusCode).toBe(415);
    const body = res.json();
    expect(body.code).not.toBe("INTERNAL_ERROR");
    expect(body.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});
