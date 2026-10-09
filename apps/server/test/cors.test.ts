import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

/** CORS（#8）：Web 记忆中心（vite dev :5173）跨源调 server API；
 *  origin 经 buildApp 注入，index.ts 从 CORS_ORIGIN 解析，默认 http://localhost:5173。 */
describe("CORS", () => {
  it("带 Origin 的请求获得对应 allow-origin 响应头", async () => {
    const app = buildApp({ corsOrigin: "http://localhost:5173" });
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    await app.close();
  });

  it("预检 OPTIONS 返回 204 与 allow-methods", async () => {
    const app = buildApp({ corsOrigin: "http://localhost:5173" });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/projects/p1/beliefs",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    await app.close();
  });

  it("未配置 corsOrigin 时不输出 CORS 响应头", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
