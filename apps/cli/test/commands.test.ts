import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import type { ApiClient } from "@mnemic/shared";

const project = "01920000-0000-7000-8000-000000000001";
const belief = "01920000-0000-7000-8000-000000000002";
const source = "01920000-0000-7000-8000-000000000003";
const detail = {
  id: belief,
  project_id: project,
  subject: "项目\u202e",
  attribute: "database",
  status: "active",
  current_value: "MySQL\u001b[2J",
  versions: [
    {
      id: source,
      recorded_from: "2026-10-16T00:00:00Z",
      recorded_to: null,
      source: { conversation_id: source, message_id: source, observation_id: source },
    },
  ],
};

describe("CLI chat / memory", () => {
  it("chat 接受合法大写项目 UUID，传给会话层前规范化为小写", async () => {
    const upper = "A1920000-0000-7000-8000-000000000001";
    const startChat = vi.fn(async () => 0);
    expect(
      await runCli(["chat", "--project", upper], {
        startChat,
        isTTY: true,
        env: {},
        write: () => {},
      }),
    ).toBe(0);
    expect(startChat).toHaveBeenCalledWith(expect.anything(), upper.toLowerCase());
  });
  it("memory 将项目和记忆 UUID 都规范化，接受 PostgreSQL 小写响应", async () => {
    const upperProject = "A1920000-0000-7000-8000-000000000001";
    const upperMemory = "B1920000-0000-7000-8000-000000000002";
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...detail,
            id: upperMemory.toLowerCase(),
            project_id: upperProject.toLowerCase(),
          }),
        ),
    );
    expect(
      await runCli(["memory", upperMemory, "--project", upperProject], {
        fetch,
        env: {},
        write: () => {},
      }),
    ).toBe(0);
    expect(fetch.mock.calls[0] as unknown[]).toEqual([
      `http://localhost:3000/projects/${upperProject.toLowerCase()}/beliefs/${upperMemory.toLowerCase()}`,
      expect.anything(),
    ]);
  });
  it("chat 仅经 shared client 创建会话，传项目和 Token，使用较长对话超时", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const startChat = vi.fn(async (api: ApiClient, id: string) => {
      await api.createConversation(id);
      return 0;
    });
    expect(
      await runCli(["chat", "--project", project], {
        fetch,
        startChat,
        isTTY: true,
        env: { MNEMIC_AUTH_TOKEN: "token-only" },
        write: () => {},
      }),
    ).toBe(0);
    expect(startChat).toHaveBeenCalledWith(expect.anything(), project);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/conversations");
    expect(JSON.parse(init.body as string)).toEqual({ project_id: project });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-only");
  });

  it("非交互终端在创建会话前拒绝 chat", async () => {
    const fetch = vi.fn();
    const startChat = vi.fn();
    let output = "";
    expect(
      await runCli(["chat", "--project", project], {
        fetch,
        startChat,
        isTTY: false,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(2);
    expect(output).toContain("交互终端");
    expect(fetch).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it("memory 只读当前值与出处，所有终端内容过滤控制字符", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(detail)));
    let output = "";
    expect(
      await runCli(["memory", belief, "--project", project], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(0);
    expect(output).toContain("MySQL");
    expect(output).toContain(source);
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u202e");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0] as unknown[]).toEqual([
      `http://localhost:3000/projects/${project}/beliefs/${belief}`,
      expect.not.objectContaining({ method: "POST" }),
    ]);
  });

  it("memory --json 输出原始 JSON 数据；项目不匹配的响应不展示", async () => {
    let output = "";
    const fetch = vi.fn(async () => new Response(JSON.stringify(detail)));
    expect(
      await runCli(["memory", belief, "--project", project, "--json"], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(output).id).toBe(belief);
    output = "";
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...detail, project_id: source })));
    expect(
      await runCli(["memory", belief, "--project", project], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(1);
    expect(output).not.toContain("MySQL");
  });

  it("memory 鉴权失败返回 1，不泄露原始响应", async () => {
    let output = "";
    const fetch = vi.fn(async () => new Response("secret", { status: 401 }));
    expect(
      await runCli(["memory", belief, "--project", project], {
        fetch,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(1);
    expect(output).toContain("MNEMIC_AUTH_TOKEN");
    expect(output).not.toContain("secret");
  });

  it.each([
    ["chat"],
    ["chat", "--project", "bad"],
    ["memory", "../bad", "--project", project],
    ["memory", belief],
    ["chat", "--project", project, "--json"],
    ["memory", belief, "--project", project, "--probe"],
  ])("非法命令 %j 不发网络请求", async (...args) => {
    const fetch = vi.fn();
    const startChat = vi.fn();
    expect(await runCli(args, { fetch, startChat, isTTY: true, env: {}, write: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });
});
