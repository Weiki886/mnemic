import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import * as config from "../src/config.js";

const TOKEN = "test-auth-" + "a".repeat(48);
const apps: ReturnType<typeof buildApp>[] = [];
function fixture(options: BuildAppOptions = {}) {
  const app = buildApp({ authToken: TOKEN, ...options } as BuildAppOptions);
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("#20 最小 Bearer 鉴权", () => {
  it("工厂默认拒绝遗漏或 undefined Token，不能静默关闭鉴权", () => {
    expect(() => buildApp()).toThrow(/MNEMIC_AUTH_TOKEN/);
    expect(() => buildApp({ authToken: undefined })).toThrow(/MNEMIC_AUTH_TOKEN/);
  });

  it("只有显式 auth:false 的测试夹具可不鉴权，doctor 不假报通过", async () => {
    const app = buildApp({ auth: false });
    apps.push(app);
    const res = await app.inject({ url: "/v1/doctor" });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().checks.find((c: { name: string }) => c.name === "authentication").status,
    ).toBe("skipped");
  });

  it("显式关闭鉴权时，即使误传 Token，doctor 也必须报告未验证", async () => {
    const app = fixture({ auth: false });
    const res = await app.inject({ url: "/v1/doctor" });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().checks.find((c: { name: string }) => c.name === "authentication").status,
    ).toBe("skipped");
  });

  it("仅健康检查公开；路径前缀/编码/业务/未知路由均不能绕过", async () => {
    const app = fixture();
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health?probe=1" })).statusCode).toBe(200);
    for (const url of [
      "/v1/doctor",
      "/providers",
      "/pending",
      "/projects/abc/beliefs",
      "/projects/abc/conversations",
      "/beliefs/abc/correct",
      "/nope",
      "/health/x",
      "/%68ealth",
    ]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.headers["www-authenticate"]).toBe('Bearer realm="mnemic"');
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
        requestId: expect.any(String),
      });
    }
  });

  it("缺失、错误、畸形或查询/cookie Token 均不能写入，鉴权先于 JSON 解析", async () => {
    const app = fixture();
    const write = vi.fn(async () => ({ ok: true }));
    app.post("/test-write", write);
    for (const headers of [
      {},
      { authorization: "Basic " + TOKEN },
      { authorization: "Bearer " + TOKEN + "x" },
      { authorization: "Bearer " + "b".repeat(TOKEN.length) },
      { authorization: "Bearer  " + TOKEN },
      { authorization: "Bearer " + TOKEN + ", Bearer " + TOKEN },
      { cookie: "token=" + TOKEN },
      { "x-api-key": TOKEN },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/test-write?token=" + TOKEN,
        headers: { ...headers, "content-type": "application/json" },
        payload: "{broken",
      });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(TOKEN);
    }
    expect(write).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/test-write",
          payload: {},
          headers: { authorization: "bearer " + TOKEN },
        })
      ).statusCode,
    ).toBe(200);
    expect(write).toHaveBeenCalledOnce();
  });

  it("通过保护后的 doctor 真实报告 authentication ok，探测无 Token 不执行", async () => {
    const app = fixture();
    const denied = await app.inject({ method: "POST", url: "/v1/doctor/probe", payload: {} });
    expect(denied.statusCode).toBe(401);
    const res = await app.inject({
      url: "/v1/doctor",
      headers: { authorization: "Bearer " + TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().checks.find((c: { name: string }) => c.name === "authentication"),
    ).toMatchObject({ status: "ok" });
    expect(res.body).not.toContain(TOKEN);
  });

  it("只放行配置源的 CORS 预检协议，不放行业务请求或任意 OPTIONS", async () => {
    const app = fixture({ corsOrigin: "https://web.example" });
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/providers/abc",
      headers: {
        origin: "https://web.example",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://web.example");
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(preflight.headers["access-control-allow-headers"]).toContain("authorization");
    expect(
      (await app.inject({ url: "/v1/doctor", headers: { origin: "https://web.example" } }))
        .statusCode,
    ).toBe(401);
    for (const headers of [
      {},
      { origin: "https://evil.example", "access-control-request-method": "POST" },
    ]) {
      expect((await app.inject({ method: "OPTIONS", url: "/v1/doctor", headers })).statusCode).toBe(
        401,
      );
    }
  });

  it("配置源可读取缺失/错误 Token 的 401；外部源不获 CORS 放行头", async () => {
    const app = fixture({ corsOrigin: "https://web.example" });
    for (const authorization of [undefined, "Bearer wrong-fixture-token"]) {
      const res = await app.inject({
        url: "/v1/doctor",
        headers: {
          origin: "https://web.example",
          ...(authorization ? { authorization } : {}),
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["access-control-allow-origin"]).toBe("https://web.example");
      expect(res.headers.vary).toContain("Origin");
      expect(res.json().code).toBe("UNAUTHORIZED");
    }
    const foreign = await app.inject({
      url: "/v1/doctor",
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.statusCode).toBe(401);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("成功/失败鉴权和查询参数中的凭据不落日志，响应不回显 Token", async () => {
    const logs: string[] = [];
    const app = fixture({ logStream: { write: (s) => logs.push(s) } });
    const wrong = "wrong-token-" + "b".repeat(40);
    for (const token of [TOKEN, wrong]) {
      for (const path of ["/v1/doctor", "/nope"]) {
        const res = await app.inject({
          url: path + "?token=" + token,
          headers: { authorization: "Bearer " + token, cookie: "sid=" + token, "x-api-key": token },
        });
        expect(res.body).not.toContain(token);
      }
    }
    const text = logs.join("");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(wrong);
  });
});

describe("鉴权启动配置 fail-closed", () => {
  const resolve = () => {
    expect(config).toHaveProperty("resolveAuthToken");
    return (config as unknown as { resolveAuthToken: (raw: string | undefined) => string })
      .resolveAuthToken;
  };
  it("合法随机 Token 原样采用", () => {
    expect(resolve()(TOKEN)).toBe(TOKEN);
  });
  it.each([
    undefined,
    "",
    "change-me",
    "a".repeat(31),
    "a".repeat(257),
    " " + TOKEN,
    TOKEN + "\n",
    "汉".repeat(40),
  ])("不合法配置拒绝且错误不带原值（%#）", (raw) => {
    const parse = resolve();
    let failure: unknown;
    try {
      parse(raw);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("MNEMIC_AUTH_TOKEN");
    if (raw) expect(String(failure)).not.toContain(raw);
  });
});
