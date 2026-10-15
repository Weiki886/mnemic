import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

const report = {
  ok: true,
  probe: false,
  configSource: "server",
  checks: [
    { name: "authentication", status: "skipped", detail: "尚未启用鉴权（#20）" },
    { name: "configuration", status: "ok", detail: "服务端配置" },
    { name: "chat", status: "skipped", detail: "使用 --probe 可能计费" },
  ],
};
const fixture = () =>
  vi.fn(
    async (url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/health")
            ? { status: "ok" }
            : { ...report, probe: String(url).endsWith("probe=true") },
        ),
      ),
  );

describe("mnemic doctor（#19 1/2）", () => {
  it("默认读取服务端配置、从环境传 Token，明确显示未验证项", async () => {
    const fetch = fixture();
    let output = "";
    const code = await runCli(["doctor"], {
      fetch,
      env: { MNEMIC_SERVER_URL: "http://localhost:3333", MNEMIC_AUTH_TOKEN: "test-bearer-secret" },
      write: (s) => {
        output += s;
      },
    });
    expect(code).toBe(0);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:3333/health",
      "http://localhost:3333/v1/doctor?probe=false",
    ]);
    const init = (fetch.mock.calls[1] as [unknown, RequestInit])[1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-bearer-secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(output).toContain("[SKIP] authentication");
    expect(output).toContain("--probe");
    expect(output).not.toContain("test-bearer-secret");
  });

  it("--server 优先于环境，--probe 显式开启探测；JSON 是可解析的聚合报告", async () => {
    const fetch = fixture();
    let output = "";
    expect(
      await runCli(["doctor", "--server", "http://localhost:4444/", "--probe", "--json"], {
        fetch,
        env: { MNEMIC_SERVER_URL: "http://localhost:9999" },
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(0);
    expect(fetch.mock.calls[1]![0]).toBe("http://localhost:4444/v1/doctor?probe=true");
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      connectivity: { status: "ok" },
      diagnostics: { ...report, probe: true },
    });
  });

  it("服务端有诊断错误时退出 1 并显示错误项", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/health")
              ? { status: "ok" }
              : {
                  ...report,
                  ok: false,
                  checks: [{ name: "chat", status: "error", detail: "chat 未配置" }],
                },
          ),
        ),
    );
    let output = "";
    expect(
      await runCli(["doctor"], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(1);
    expect(output).toContain("[ERROR] chat");
  });

  it.each([401, 403])("鉴权拒绝 %s 有可操作提示，不输出原始响应中的凭据", async (status) => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/health")
        ? new Response('{"status":"ok"}')
        : new Response("upstream token-secret", { status }),
    );
    let output = "";
    expect(
      await runCli(["doctor"], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(1);
    expect(output).toContain("MNEMIC_AUTH_TOKEN");
    expect(output).not.toContain("token-secret");
  });

  it("连接失败或超时返回 1，不把原始网络异常写入终端", async () => {
    let output = "";
    const fetch = vi.fn(async () => {
      throw new Error("private-network-secret");
    });
    expect(
      await runCli(["doctor", "--json"], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ ok: false, diagnostics: null });
    expect(fetch).toHaveBeenCalledOnce();
    expect(output).not.toContain("private-network-secret");
  });

  it("不兼容的诊断响应退出 1", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(String(url).endsWith("/health") ? { status: "ok" } : { wrong: true }),
        ),
    );
    expect(await runCli(["doctor"], { fetch, env: {}, write: () => {} })).toBe(1);
  });

  it.each([
    ["other"],
    ["doctor", "extra"],
    ["doctor", "--unknown"],
    ["doctor", "--server", "file:///tmp/test"],
    ["doctor", "--server", "https://user:secret@example.com"],
    ["doctor", "--server", "https://example.com?token=secret"],
  ])("无效参数 %j 退出 2，不请求网络", async (...args) => {
    const fetch = fixture();
    let output = "";
    expect(
      await runCli(args, {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(output).not.toContain("secret");
  });

  it("帮助说明探测费用，不请求网络", async () => {
    const fetch = fixture();
    let output = "";
    expect(
      await runCli(["--help"], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(0);
    expect(output).toContain("可能计费");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("终端文本剥离控制字符，服务端内容不能注入 ANSI 指令", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/health")
              ? { status: "ok" }
              : {
                  ...report,
                  checks: [{ name: "chat", status: "skipped", detail: "\u001b[2Jtest\rnext" }],
                },
          ),
        ),
    );
    let output = "";
    await runCli(["doctor"], {
      fetch,
      env: {},
      write: (s) => {
        output += s;
      },
    });
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\r");
  });
});
